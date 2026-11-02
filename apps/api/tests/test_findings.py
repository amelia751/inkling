"""todo17 D5, D9, D10: findings (record / resolve), the rules.scan job, fixes, promotion,
the project context and the gardener."""

from __future__ import annotations

import json
import sys
import types
from datetime import UTC, datetime

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.kernel import findings
from studio_api.kernel import rules as krules
from studio_api.kernel.lint import violation
from studio_api.models import AnnotationDocumentRow, LintFinding, ProjectRow, ScheduledRun, SourceNode, TaskRow

from .test_files import _agent, _by_name, _new

RULES = {
    "labels": [{"id": "lesion", "name": "Lesion", "synonyms": ["tumour"], "allowedGeometries": []}],
    "layout": {"folderPatterns": ["study", "study/*"], "fileNamePattern": r"[a-z0-9_]+\.png"},
    "datasets": {"requiredMetadata": ["modality"]},
}


def _ann(i: str, label: str) -> dict:
    return {"id": i, "itemId": "item-1", "label": label, "provenance": "human", "author": "user:x", "createdAt": "2026-01-01T00:00:00Z", "geometry": {"type": "box", "x": 0, "y": 0, "w": 1, "h": 1}}


def _project(client, monkeypatch, rules: dict | None = None) -> tuple[str, str]:
    """A project with study/ok.png, study/Bad Name.png, misc/stray.png, a published Studio whose
    document holds a synonym ('tumour'), and rules saved at revision 1."""
    p, _, _ = _new(client, {"study/ok.png": b"\x89PNG", "study/Bad Name.png": b"\x89PNG", "misc/stray.png": b"\x89PNG"})
    n = _by_name(p)
    # The import's top folder is the drive's first level; point the layout at it.
    r = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "Scans", "nodeIds": [n["ok.png"].id], "task": {"title": "Outline", "preset": "preset:image-2d"}})
    assert r.status_code < 300, r.text
    monkeypatch.setattr(krules, "_preset_rules", lambda preset, root: None)
    with kdb.session_scope() as db:
        task = db.scalars(select(TaskRow).where(TaskRow.project_id == p)).first()
        assert task is not None
        tid = task.id
        row = db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.task_id == tid)).first()
        if row is None:
            row = AnnotationDocumentRow(workspace_id=p, task_id=tid, revision=0, annotations=[])
            db.add(row)
        row.annotations = [_ann("a1", "tumour"), _ann("a2", "Lesion")]
    # Paths start with the import's top folder; anchor the folder patterns there.
    top = _paths(p)[n["ok.png"].id].split("/")[0]
    doc = json.loads(json.dumps(rules or RULES).replace('"study', f'"{top}/study')) if top != "study" else (rules or RULES)
    r = client.put(f"/api/v1/projects/{p}/rules", json={"rules": doc, "baseRevision": 0})
    assert r.status_code == 200, r.text
    return p, tid


def _paths(p: str) -> dict[str, str]:
    from studio_api.kernel import tree

    with kdb.session_scope() as db:
        ids = list(db.scalars(select(SourceNode.id).where(SourceNode.project_id == p, SourceNode.is_dir.is_(False))))
        return tree.paths_of(db, ids)


def _open(client, p: str) -> list[dict]:
    return client.get(f"/api/v1/projects/{p}/findings").json()["findings"]


# ---- record / resolve ----------------------------------------------------------------------


def test_record_upserts_and_resolves_what_is_no_longer_reported(client):
    p = client.post("/api/v1/projects", json={"title": "F"}).json()["id"]
    v1 = violation("label.unknown", "/annotations/a1/label", "'x' is not a label.")
    v2 = violation("label.synonym", "/annotations/a2/label", "'tumour' is a synonym.")
    with kdb.session_scope() as db:
        assert findings.record(db, p, "annotation", "t1", [v1, v2], "write") == {"recorded": 2, "resolved": 0}
        # Same again: upserted, nothing new.
        assert findings.record(db, p, "annotation", "t1", [v1, v2], "write") == {"recorded": 0, "resolved": 0}
        # A later write that no longer reports v2 resolves it; a foreign code (imaging) is untouched.
        findings.record(db, p, "file", "n1", [{"rule": "dicom.series-incomplete", "severity": "warn", "path": "", "message": "3 slices missing"}], "scan", codes={"dicom.series-incomplete"})
        assert findings.record(db, p, "annotation", "t1", [v1], "write") == {"recorded": 0, "resolved": 1}
        assert findings.record(db, p, "file", "n1", [], "write") == {"recorded": 0, "resolved": 0}
        # It comes back: reopened.
        assert findings.record(db, p, "annotation", "t1", [v1, v2], "scan")["recorded"] == 1
        rows = list(db.scalars(select(LintFinding).where(LintFinding.project_id == p)))
        assert len(rows) == 3 and all(r.resolved_at is None for r in rows)
        assert findings.resolve_missing(db, p, "annotation", "t1", [("label.unknown", "/annotations/a1/label")]) == 1
    out = client.get(f"/api/v1/projects/{p}/findings").json()
    assert {f["rule"] for f in out["findings"]} == {"label.unknown", "dicom.series-incomplete"}
    assert out["counts"] == {"error": 1, "warn": 1, "info": 0}
    every = client.get(f"/api/v1/projects/{p}/findings", params={"state": "all"}).json()["findings"]
    syn = next(f for f in every if f["rule"] == "label.synonym")
    assert syn["resolvedAt"] and syn["fixable"] is True and syn["mode"] == "enforce" and syn["fix"]
    assert set(syn) == {"id", "resourceKind", "resourceId", "rule", "severity", "path", "message", "fix", "fixable", "mode", "source", "firstSeen", "resolvedAt"}


def test_would_have_rejected_counts_evaluate_mode_errors_from_writes(client, monkeypatch):
    p = client.post("/api/v1/projects", json={"title": "F"}).json()["id"]
    monkeypatch.setattr(krules, "_preset_rules", lambda preset, root: None)
    mixed = violation("dataset.mixed-modality", "/dataset/modalities", "more than one modality")
    mixed.severity = "error"  # severityOverrides made it an error; still in evaluate mode
    with kdb.session_scope() as db:
        findings.record(db, p, "dataset", "d1", [mixed], "write")
        findings.record(db, p, "dataset", "d2", [mixed], "write")
        findings.record(db, p, "dataset", "d3", [mixed], "scan")  # scans are not writes
        findings.record(db, p, "dataset", "d4", [violation("dataset.metadata-missing", "/dataset/metadata/x", "x")], "write")  # enforced: really rejected
    out = client.get(f"/api/v1/projects/{p}/findings").json()
    assert out["wouldHaveRejected"] == {"dataset.mixed-modality": 2}
    assert {f["mode"] for f in out["findings"] if f["rule"] == "dataset.mixed-modality"} == {"evaluate"}
    # Promotion is a rules edit (history) and ends evaluate mode.
    r = client.post(f"/api/v1/projects/{p}/rules/promote", json={"rule": "dataset.mixed-modality", "severity": "error"})
    assert r.status_code == 200, r.text
    assert r.json()["rules"]["severityOverrides"]["dataset.mixed-modality"] == "error" and r.json()["rules"]["enforce"] == ["dataset.mixed-modality"]
    hist = client.get(f"/api/v1/projects/{p}/rules/history").json()["history"]
    assert hist[0]["revision"] == r.json()["revision"] == 1
    out = client.get(f"/api/v1/projects/{p}/findings").json()
    assert out["wouldHaveRejected"] == {} and {f["mode"] for f in out["findings"] if f["rule"] == "dataset.mixed-modality"} == {"enforce"}
    assert client.post(f"/api/v1/projects/{p}/rules/promote", json={"rule": "nope", "severity": "error"}).status_code == 422


# ---- scan ----------------------------------------------------------------------------------


def test_scan_finds_a_synonym_and_a_misplaced_file_and_clears_them_later(client, monkeypatch):
    p, tid = _project(client, monkeypatch)
    # The rules change enqueued a scan; the worker's scheduled call drains it.
    with kdb.session_scope() as db:
        queued = [r for r in db.scalars(select(ScheduledRun).where(ScheduledRun.name == findings.SCAN_JOB)) if r.result and r.result.get("projectId") == p]
        assert queued and queued[0].result["state"] == "queued"
    r = client.post("/api/v1/worker/scheduled/rules.scan", json={}, headers={"X-Worker-Token": _worker_token()})
    assert r.status_code == 200, r.text
    open_ = _open(client, p)
    by_rule = {f["rule"]: f for f in open_}
    assert by_rule["label.synonym"]["resourceId"] == tid and by_rule["label.synonym"]["path"] == "/annotations/a1/label"
    assert by_rule["label.synonym"]["source"] == "scan"
    n = _by_name(p)
    assert by_rule["layout.misplaced"]["resourceId"] == n["stray.png"].id
    assert by_rule["name.pattern"]["resourceId"] == n["Bad Name.png"].id
    assert by_rule["dataset.metadata-missing"]["resourceKind"] == "dataset"
    assert all("stray" not in f["message"] and "Bad Name" not in f["message"] for f in open_)
    # Rules without a layout: the next scan resolves the layout findings.
    cur = client.get(f"/api/v1/projects/{p}/rules").json()
    client.put(f"/api/v1/projects/{p}/rules", json={"rules": {**cur["rules"], "layout": {}}, "baseRevision": cur["revision"]})
    out = client.post(f"/api/v1/projects/{p}/scan").json()
    assert out["jobId"] and out["state"] == "done" and out["result"]["resolved"] >= 2
    assert {f["rule"] for f in _open(client, p)} == {"label.synonym", "dataset.metadata-missing"}


def test_daily_scan_runs_once_a_day_from_the_hour(client, monkeypatch):
    p, _ = _project(client, monkeypatch)
    with kdb.session_scope() as db:
        assert findings.daily(db, hour=3, now=datetime(2026, 1, 1, 2, tzinfo=UTC))["ran"] is False
        assert findings.daily(db, hour=3, now=datetime(2026, 1, 1, 4, tzinfo=UTC))["ran"] is True
        assert findings.daily(db, hour=3, now=datetime(2026, 1, 1, 5, tzinfo=UTC))["ran"] is False
    assert any(f["rule"] == "label.synonym" for f in _open(client, p))


def _worker_token() -> str:
    from studio_api.routes.worker import worker_token

    return worker_token()


# ---- fixes ---------------------------------------------------------------------------------


def test_person_fix_applies_synonym_and_rename(client, monkeypatch):
    p, tid = _project(client, monkeypatch)
    client.post(f"/api/v1/projects/{p}/scan")
    by_rule = {f["rule"]: f for f in _open(client, p)}
    r = client.post(f"/api/v1/projects/{p}/findings/{by_rule['label.synonym']['id']}/fix")
    assert r.status_code == 200 and r.json() == {"applied": True}
    with kdb.session_scope() as db:
        doc = db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.task_id == tid)).first()
        assert [a["label"] for a in doc.annotations] == ["Lesion", "Lesion"]
    r = client.post(f"/api/v1/projects/{p}/findings/{by_rule['name.pattern']['id']}/fix")
    assert r.status_code == 200, r.text
    assert "bad_name.png" in _by_name(p)
    left = {f["rule"] for f in _open(client, p)}
    assert "label.synonym" not in left and "name.pattern" not in left
    # Not fixable: 409.
    assert client.post(f"/api/v1/projects/{p}/findings/{by_rule['layout.misplaced']['id']}/fix").status_code == 409
    assert client.post(f"/api/v1/projects/{p}/findings/nope/fix").status_code == 404


def _fake_change_requests(monkeypatch) -> list[dict]:
    calls: list[dict] = []
    mod = types.ModuleType("studio_api.kernel.change_requests")

    def open_or_append(db, ctx, op_id, input, *, title=None):
        calls.append({"op": op_id, "input": input, "title": title, "actor": ctx.principal})
        return {"id": "cr-1", "title": title, "state": "open", "operations": [{"op": c["op"], "input": c["input"]} for c in calls], "mergedBy": None}

    mod.open_or_append = open_or_append  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "studio_api.kernel.change_requests", mod)
    import studio_api.kernel as k

    monkeypatch.setattr(k, "change_requests", mod, raising=False)
    return calls


def test_agent_fix_opens_a_change_request(client, monkeypatch):
    p, tid = _project(client, monkeypatch)
    client.post(f"/api/v1/projects/{p}/scan")
    syn = next(f for f in _open(client, p) if f["rule"] == "label.synonym")
    calls = _fake_change_requests(monkeypatch)
    r = client.post(f"/api/v1/projects/{p}/findings/{syn['id']}/fix", headers=_agent(p))
    assert r.status_code == 200, r.text
    assert r.json()["changeRequest"]["state"] == "open"
    assert calls == [{"op": "annotation.relabel", "input": {"taskId": tid, "annotationId": "a1", "label": "Lesion"}, "title": "Fix label.synonym", "actor": "agent:run_1"}]
    with kdb.session_scope() as db:  # nothing applied
        doc = db.scalars(select(AnnotationDocumentRow).where(AnnotationDocumentRow.task_id == tid)).first()
        assert doc.annotations[0]["label"] == "tumour"


def test_gardener_opens_one_change_request_and_never_merges(client, monkeypatch):
    p, _ = _project(client, monkeypatch)
    client.post(f"/api/v1/projects/{p}/scan")
    calls = _fake_change_requests(monkeypatch)
    r = client.post(f"/api/v1/projects/{p}/gardener", headers=_agent(p))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["fixes"] == 2 and out["changeRequest"]["id"] == "cr-1" and out["changeRequest"]["mergedBy"] is None
    assert {c["title"] for c in calls} == {"Tidy: 2 fixes"}
    assert sorted(c["op"] for c in calls) == ["annotation.relabel", "source.rename"]
    # Nothing changed: the findings stay open until the change request is merged.
    assert {"label.synonym", "name.pattern"} <= {f["rule"] for f in _open(client, p)}


def test_without_change_requests_an_agent_fix_is_503(client, monkeypatch):
    p, _ = _project(client, monkeypatch)
    client.post(f"/api/v1/projects/{p}/scan")
    syn = next(f for f in _open(client, p) if f["rule"] == "label.synonym")
    monkeypatch.setattr(findings, "_change_requests", lambda: None)
    assert client.post(f"/api/v1/projects/{p}/findings/{syn['id']}/fix", headers=_agent(p)).status_code == 503


# ---- context -------------------------------------------------------------------------------


def test_context_shape(client, monkeypatch):
    p, tid = _project(client, monkeypatch)
    client.post(f"/api/v1/projects/{p}/scan")
    for headers in ({}, _agent(p)):
        r = client.get(f"/api/v1/projects/{p}/context", headers=headers)
        assert r.status_code == 200, r.text
        c = r.json()
        assert set(c) == {"project", "rules", "rulesSource", "findings", "published", "recentChanges", "howToAddData"}
        with kdb.session_scope() as db:
            title = db.get(ProjectRow, p).title
        assert c["project"] == {"id": p, "name": title, "preset": "image-2d"}
        assert c["rulesSource"] == "project" and c["rules"]["labels"][0]["synonyms"] == ["tumour"]
        assert c["rules"]["requiredMetadata"] == ["modality"]
        assert c["findings"]["byRule"]["label.synonym"] == 1
        assert [s["id"] for s in c["published"]["studios"]] == [tid] and len(c["published"]["datasets"]) == 1
        assert any(ch["kind"] == "rules" for ch in c["recentChanges"])
        assert "tumour" in c["howToAddData"] and "modality" in c["howToAddData"]
