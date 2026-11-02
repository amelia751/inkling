"""todo17 D11: imaging checks in the kernel. Import completion queues `imaging.check` for the
imaging files (never blocking the upload), the worker's findings land in `lint_findings` through
the service route, a later clean check resolves them, and exports are gated by severity."""

from __future__ import annotations

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.kernel import imaging_findings, service_jobs
from studio_api.models import LintFinding, PluginJob

from .test_files import _by_name, _new

WORKER = {"X-Worker-Token": "dev-only-worker-token"}


def _jobs(pid: str) -> list[PluginJob]:
    with kdb.session_scope() as db:
        rows = list(db.scalars(select(PluginJob).where(PluginJob.workspace_id == pid, PluginJob.plugin_id == service_jobs.PLUGIN, PluginJob.tool == imaging_findings.TOOL)))
        for r in rows:
            db.expunge(r)
    return rows


def _open(pid: str) -> list[LintFinding]:
    with kdb.session_scope() as db:
        rows = list(db.scalars(select(LintFinding).where(LintFinding.project_id == pid, LintFinding.resolved_at.is_(None))))
        for r in rows:
            db.expunge(r)
    return rows


def test_import_queues_a_check_for_imaging_files_only(client):
    p, _, imp = _new(client, {"mri/scan.nii.gz": b"\x1f\x8b fake", "mri/IM0001": b"dicom-ish", "notes.csv": b"k,v\n"})
    assert imp["state"] in ("inspecting", "ready", "needs_review")  # the upload finished regardless
    jobs = _jobs(p)
    assert len(jobs) == 1
    names = sorted(n["name"] for n in jobs[0].input["nodes"])
    assert names == ["IM0001", "scan.nii.gz"] and jobs[0].input["trigger"] == "import"


def test_findings_route_records_resolves_and_needs_the_worker_token(client):
    p, _, _ = _new(client, {"mri/scan.nii.gz": b"x"})
    nid = _by_name(p)["scan.nii.gz"].id
    v = {"rule": "nifti.nan", "severity": "warn", "path": "/data", "message": "3 of 64 voxels are NaN"}
    assert client.post(f"/api/v1/service/projects/{p}/findings", json={"resourceKind": "file", "resourceId": nid, "violations": [v], "source": "scan"}).status_code == 401
    r = client.post(f"/api/v1/service/projects/{p}/findings", json={"resourceKind": "file", "resourceId": nid, "violations": [v, {"rule": "label.unknown", "path": "/x", "message": "ignored"}], "source": "scan"}, headers=WORKER)
    assert r.status_code == 200 and r.json()["opened"] == 1
    rows = _open(p)
    assert [(x.rule, x.severity, x.resource_kind, x.source) for x in rows] == [("nifti.nan", "warn", "file", "scan")]
    # The same finding again is kept, not duplicated; a clean check resolves it.
    assert client.post(f"/api/v1/service/projects/{p}/findings", json={"results": [{"resourceKind": "file", "resourceId": nid, "violations": [v]}], "source": "scan"}, headers=WORKER).json()["kept"] == 1
    assert client.post(f"/api/v1/service/projects/{p}/findings", json={"results": [{"resourceKind": "file", "resourceId": nid, "violations": []}], "source": "scan"}, headers=WORKER).json()["resolved"] == 1
    assert _open(p) == []
    assert client.post(f"/api/v1/service/projects/{p}/findings", json={"resourceKind": "bogus", "resourceId": nid, "violations": []}, headers=WORKER).status_code == 422


def test_project_rules_set_imaging_severity(client):
    p, _, _ = _new(client, {"mri/scan.nii.gz": b"x"})
    nid = _by_name(p)["scan.nii.gz"].id
    cur = client.get(f"/api/v1/projects/{p}/rules").json()
    rules = {**cur["rules"], "imaging": {"checks": {"nifti.nan": "off", "nifti.orientation-mismatch": "error"}}}
    assert client.put(f"/api/v1/projects/{p}/rules", json={"rules": rules, "baseRevision": cur["revision"]}).status_code == 200
    vs = [{"rule": "nifti.nan", "path": "/data", "message": "n"}, {"rule": "nifti.orientation-mismatch", "path": "/qform", "message": "q"}]
    client.post(f"/api/v1/service/projects/{p}/findings", json={"resourceKind": "file", "resourceId": nid, "violations": vs}, headers=WORKER)
    assert [(x.rule, x.severity) for x in _open(p)] == [("nifti.orientation-mismatch", "error")]


def test_export_is_gated_by_error_findings_unless_a_person_forces_it(client):
    p, _, _ = _new(client, {"mri/scan.nii.gz": b"x", "mri/mask_seg.nii.gz": b"y"})
    n = _by_name(p)
    folder = n["mri"].id
    # A warning: the export goes through and counts it.
    client.post(f"/api/v1/service/projects/{p}/findings", json={"resourceKind": "file", "resourceId": n["scan.nii.gz"].id, "violations": [{"rule": "nifti.nan", "path": "/data", "message": "NaN"}]}, headers=WORKER)
    r = client.post(f"/api/v1/projects/{p}/fs/zip", json={"nodeIds": [folder]})
    assert r.status_code == 200 and r.headers["X-Imaging-Findings"] == "1"
    assert any(j.input["trigger"] == "export" for j in _jobs(p))
    # An error the project gates on (evaluate-mode codes gate once the project sets them).
    cur = client.get(f"/api/v1/projects/{p}/rules").json()
    rules = {**cur["rules"], "imaging": {"checks": {"nifti.grid-mismatch": "error"}}}
    client.put(f"/api/v1/projects/{p}/rules", json={"rules": rules, "baseRevision": cur["revision"]})
    client.post(f"/api/v1/service/projects/{p}/findings", json={"resourceKind": "file", "resourceId": n["mask_seg.nii.gz"].id, "violations": [{"rule": "nifti.grid-mismatch", "path": "/dim", "message": "shape differs"}]}, headers=WORKER)
    r = client.post(f"/api/v1/projects/{p}/fs/zip", json={"nodeIds": [folder]})
    assert r.status_code == 422 and r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert body["code"] == "export_blocked" and {f["rule"] for f in body["findings"]} == {"nifti.grid-mismatch", "nifti.nan"}
    assert all("value" not in v for v in body["violations"])
    # A person may export anyway.
    r = client.post(f"/api/v1/projects/{p}/fs/zip", json={"nodeIds": [folder], "force": True})
    assert r.status_code == 200 and r.headers["X-Imaging-Findings"] == "2"
    # Exporting only the image (not the mask) isn't blocked.
    assert client.post(f"/api/v1/projects/{p}/fs/zip", json={"nodeIds": [n["scan.nii.gz"].id]}).status_code == 200


def test_series_findings_gate_exports_through_the_series_key(client):
    p, _, _ = _new(client, {"ct/IM1": b"a", "ct/IM2": b"b"})
    n = _by_name(p)
    with kdb.session_scope() as db:
        for name in ("IM1", "IM2"):
            row = db.get(type(n[name]), n[name].id)
            row.facts = {**(row.facts or {}), "series_uid_hash": "abc123"}
    client.post(f"/api/v1/service/projects/{p}/findings", json={"resourceKind": "series", "resourceId": "abc123", "violations": [{"rule": "dicom.seg-frame-mismatch", "path": "/FrameOfReferenceUID", "message": "m"}]}, headers=WORKER)
    # Evaluate mode by default: recorded, but the export only warns.
    r = client.post(f"/api/v1/projects/{p}/fs/zip", json={"nodeIds": [n["IM2"].id]})
    assert r.status_code == 200 and r.headers["X-Imaging-Findings"] == "1"
