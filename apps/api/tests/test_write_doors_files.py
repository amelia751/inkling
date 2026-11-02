"""todo17 W-WIRE-B: files, imports, datasets and projects through the write pipeline (D1, D6, D8,
D13): layout and dataset rules on every write, problem JSON with every violation, findings on
success, dry run, idempotency keys, preset rules stored on new projects, rules in commits."""

from __future__ import annotations

import functools
import json

import pytest
from sqlalchemy import func, select

from studio_api import db as kdb
from studio_api.kernel import rules as krules
from studio_api.kernel import studio_defs
from studio_api.models import DatasetRow, ProjectRules, SourceNode

from .conftest import SAMPLE_TEAM
from .test_files import _by_name, _new, _ops
from .test_projects import _session_body
from .test_versioning import ALICE, fake, save, vc, work  # noqa: F401

LAYOUT = {"folderPatterns": ["images/**", "labels/**"], "forbiddenCharacters": "<>:|?*", "maxDepth": 3, "fileNamePattern": r"[a-z0-9_]+\.(png|dcm)"}


@pytest.fixture
def make_client(make_client):
    """alice works on the seed project too (the versioning fixture's dataset lives there)."""
    return functools.partial(make_client, sample_editors=SAMPLE_TEAM)


DATASETS = {"requiredMetadata": ["modality", "license", "source", "description"], "oneModalityPerDataset": True, "uniqueNames": True}


def _rules(client, pid: str, **sections) -> dict:
    cur = client.get(f"/api/v1/projects/{pid}/rules").json()
    r = client.put(f"/api/v1/projects/{pid}/rules", json={"rules": {**cur["rules"], **sections}, "baseRevision": cur["revision"]})
    assert r.status_code == 200, r.text
    return r.json()


def _project(client, files=None, **sections) -> tuple[str, dict]:
    p, _, _ = _new(client, files or {"images/scan_01.png": b"\x89PNG-1"})
    if sections:
        _rules(client, p, **sections)
    return p, _by_name(p)


def _rule_codes(body: dict, key: str) -> list[str]:
    return sorted(v["rule"] for v in body[key])


# ---- Files: layout family ----------------------------------------------------------------------


def test_good_mkdir_passes_with_no_findings(client):
    p, n = _project(client, layout=LAYOUT)
    r = _ops(client, p, [{"kind": "mkdir", "parentId": n["images"].id, "name": "ct"}])
    assert r.status_code == 200, r.text
    assert r.json()["findings"] == []


def test_misplaced_file_in_misc_stuff_names_the_folder_to_use(client):
    p, n = _project(client, layout=LAYOUT)
    root = client.get(f"/api/v1/projects/{p}/fs").json()["rootNodeId"]
    misc = _ops(client, p, [{"kind": "mkdir", "parentId": root, "name": "misc"}]).json()["nodes"][0]["id"]
    stuff = _ops(client, p, [{"kind": "mkdir", "parentId": misc, "name": "stuff"}]).json()["nodes"][0]["id"]
    # Evaluate mode (D5): the move lands, the finding says where the file belongs.
    r = _ops(client, p, [{"kind": "move", "nodeIds": [n["scan_01.png"].id], "parentId": stuff}])
    assert r.status_code == 200, r.text
    (f,) = [f for f in r.json()["findings"] if f["rule"] == "layout.misplaced"]
    assert f["evaluate"] is True and "'images/'" in f["fix"] and f["allowed"] == LAYOUT["folderPatterns"]
    assert "value" not in f  # a path may carry PHI: never echoed
    # Promoted: the same move is rejected, with the fix.
    _rules(client, p, layout=LAYOUT, enforce=["layout.misplaced"], severityOverrides={"layout.misplaced": "error"})
    images = _by_name(p)["images"].id
    assert _ops(client, p, [{"kind": "move", "nodeIds": [n["scan_01.png"].id], "parentId": images}]).status_code == 200
    r = _ops(client, p, [{"kind": "move", "nodeIds": [n["scan_01.png"].id], "parentId": stuff}])
    assert r.status_code == 422 and r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert body["code"] == "write_rejected" and "'images/'" in body["violations"][0]["fix"]
    assert _by_name(p)["scan_01.png"].parent_id == images  # all or nothing


def test_rejection_lists_every_violation_at_once(client):
    p, n = _project(client, layout=LAYOUT)
    # forbidden-char is enforced; everything else rides along in the same problem.
    r = _ops(client, p, [{"kind": "mkdir", "parentId": n["images"].id, "name": "a?b"}, {"kind": "rename", "nodeId": n["scan_01.png"].id, "name": "Bad*Name.png"}])
    assert r.status_code == 422, r.text
    v = r.json()["violations"]
    assert [x["rule"] for x in v].count("layout.forbidden-char") == 2
    assert "name.pattern" in [x["rule"] for x in v]
    assert all("value" not in x for x in v)
    assert "a?b" not in _by_name(p)


def test_name_pattern_and_too_deep_warn(client):
    p, n = _project(client, layout=LAYOUT)
    r = _ops(client, p, [{"kind": "rename", "nodeId": n["scan_01.png"].id, "name": "Scan01.png"}])
    assert r.status_code == 200 and _rule_codes(r.json(), "findings") == ["name.pattern"]
    parent = n["images"].id
    for name in ("a", "b", "c"):
        parent = _ops(client, p, [{"kind": "mkdir", "parentId": parent, "name": name}]).json()["nodes"][0]["id"]
    r = _ops(client, p, [{"kind": "move", "nodeIds": [n["scan_01.png"].id], "parentId": parent}])
    assert r.status_code == 200 and "layout.too-deep" in _rule_codes(r.json(), "findings")


def test_phi_suspect_names_are_reported_never_echoed(client):
    p, n = _project(client)
    r = _ops(client, p, [{"kind": "rename", "nodeId": n["scan_01.png"].id, "name": "Smith_John_1962-04-03.png"}])
    assert r.status_code == 200, r.text
    (f,) = [f for f in r.json()["findings"] if f["rule"] == "name.phi-suspect"]
    assert f["evaluate"] is True and "Smith" not in json.dumps(f) and "1962" not in json.dumps(f)


def test_names_are_trimmed_and_nfc(client):
    p, n = _project(client)
    r = _ops(client, p, [{"kind": "mkdir", "parentId": n["images"].id, "name": "  Café  "}])
    assert r.status_code == 200, r.text
    assert "Café" in _by_name(p)


def test_dry_run_saves_nothing(client):
    p, n = _project(client, layout=LAYOUT)
    r = client.post(f"/api/v1/projects/{p}/fs/ops?dryRun=true", json={"ops": [{"kind": "rename", "nodeId": n["scan_01.png"].id, "name": "Scan01.png"}]})
    assert r.status_code == 200, r.text
    assert r.json()["dryRun"] is True and _rule_codes(r.json(), "findings") == ["name.pattern"]
    assert "scan_01.png" in _by_name(p) and "Scan01.png" not in _by_name(p)
    bad = client.post(f"/api/v1/projects/{p}/fs/ops?dryRun=true", json={"ops": [{"kind": "mkdir", "parentId": n["images"].id, "name": "x|y"}]})
    assert bad.status_code == 422 and bad.json()["violations"][0]["rule"] == "layout.forbidden-char"


def test_idempotent_replay_and_reused_key(client):
    p, n = _project(client)
    body = {"ops": [{"kind": "mkdir", "parentId": n["images"].id, "name": "once"}]}
    h = {"Idempotency-Key": "k-mkdir-1"}
    a = client.post(f"/api/v1/projects/{p}/fs/ops", json=body, headers=h)
    b = client.post(f"/api/v1/projects/{p}/fs/ops", json=body, headers=h)
    assert a.status_code == b.status_code == 200 and a.json()["batchId"] == b.json()["batchId"]
    assert b.headers.get("Idempotent-Replayed") == "true"
    with kdb.session_scope() as db:
        assert db.scalar(select(func.count()).select_from(SourceNode).where(SourceNode.project_id == p, SourceNode.name.like("once%"))) == 1
    other = client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "mkdir", "parentId": n["images"].id, "name": "twice"}]}, headers=h)
    assert other.status_code == 422 and other.json()["code"] == "idempotency_key_reused"


# ---- Imports ------------------------------------------------------------------------------------


def test_upload_is_never_blocked_by_evaluate_rules_and_forbidden_chars_are_replaced(client):
    p, _ = _project(client, layout=LAYOUT)
    body = _session_body({"misc/stuff/Scan?01.png": b"\x89PNG-2"})
    r = client.post(f"/api/v1/projects/{p}/imports", json=body)
    assert r.status_code == 201, r.text
    out = r.json()
    assert out["files"][0]["relPath"].endswith("Scan_01.png")
    codes = _rule_codes(out, "findings")
    assert "layout.forbidden-char" in codes and "layout.misplaced" in codes and "name.pattern" in codes


def test_import_dry_run_and_idempotency(client):
    p, _ = _project(client)
    body = _session_body({"images/scan_02.png": b"\x89PNG-3"})
    r = client.post(f"/api/v1/projects/{p}/imports?dryRun=true", json=body)
    assert r.status_code == 201 and r.json()["dryRun"] is True
    assert client.get(f"/api/v1/projects/{p}/imports").json()["imports"].__len__() == 1  # only the setup import
    h = {"Idempotency-Key": "imp-1"}
    a = client.post(f"/api/v1/projects/{p}/imports", json=body, headers=h).json()
    b = client.post(f"/api/v1/projects/{p}/imports", json=body, headers=h)
    assert b.status_code == 201 and b.json()["id"] == a["id"]


# ---- Datasets: datasets family ------------------------------------------------------------------


def _ds(client, pid, nodes, **body):
    return client.post(f"/api/v1/projects/{pid}/datasets", json={"title": "Scans", "nodeIds": [nodes["scan_01.png"].id], **body})


def test_dataset_without_metadata_lists_every_missing_field(client):
    p, n = _project(client, datasets={**DATASETS}, enforce=["dataset.metadata-missing"])
    r = _ds(client, p, n)
    assert r.status_code == 422, r.text
    v = r.json()["violations"]
    assert sorted(x["path"] for x in v if x["rule"] == "dataset.metadata-missing") == [f"/dataset/metadata/{k}" for k in ("description", "license", "modality", "source")]
    with kdb.session_scope() as db:
        assert db.scalar(select(func.count()).select_from(DatasetRow).where(DatasetRow.project_id == p)) == 0


def test_dataset_metadata_in_evaluate_mode_is_a_finding(client):
    p, n = _project(client, datasets={**DATASETS})
    r = _ds(client, p, n, metadata={"modality": "CT"})
    assert r.status_code == 201, r.text
    assert _rule_codes(r.json(), "findings") == ["dataset.metadata-missing"] * 3


def test_dataset_good_name_taken_and_update(client):
    p, n = _project(client, datasets={**DATASETS})
    full = {"metadata": {"modality": "CT", "license": "CC-BY-4.0", "source": "synthetic"}, "description": "Scans for testing"}
    r = _ds(client, p, n, **full)
    assert r.status_code == 201 and r.json()["findings"] == [], r.text
    assert r.json()["definition"]["metadata"]["license"] == "CC-BY-4.0"
    dup = _ds(client, p, n, title=" scans ", **full)
    assert dup.status_code == 422 and [x["rule"] for x in dup.json()["violations"]] == ["dataset.name-taken"]
    assert "value" not in dup.json()["violations"][0]
    # Update: its own name isn't taken; mixed modality is evaluate mode.
    ds = r.json()["id"]
    u = client.patch(f"/api/v1/projects/{p}/datasets/{ds}", json={"name": "Scans", "metadata": {"modality": "MR"}})
    assert u.status_code == 200, u.text
    assert u.json()["metadata"]["modality"] == "MR"
    dry = client.patch(f"/api/v1/projects/{p}/datasets/{ds}?dryRun=true", json={"name": "Renamed"})
    assert dry.status_code == 200 and dry.json()["dryRun"] is True
    with kdb.session_scope() as db:
        assert db.get(DatasetRow, ds).title == "Scans"


def test_dataset_dry_run_and_idempotency(client):
    p, n = _project(client)
    r = _ds(client, p, n, title="Dry")
    assert r.status_code == 201
    r = client.post(f"/api/v1/projects/{p}/datasets?dryRun=true", json={"title": "Dry2", "nodeIds": [n["scan_01.png"].id]})
    assert r.status_code == 201 and r.json()["dryRun"] is True
    h = {"Idempotency-Key": "ds-1"}
    body = {"title": "Once", "nodeIds": [n["scan_01.png"].id]}
    a = client.post(f"/api/v1/projects/{p}/datasets", json=body, headers=h)
    b = client.post(f"/api/v1/projects/{p}/datasets", json=body, headers=h)
    assert a.status_code == b.status_code == 201 and a.json()["id"] == b.json()["id"]
    with kdb.session_scope() as db:
        titles = list(db.scalars(select(DatasetRow.title).where(DatasetRow.project_id == p)))
    assert sorted(titles) == ["Dry", "Once"]


# ---- Projects: preset rules stored ---------------------------------------------------------------


PRESET_RULES = {"layout": {"maxDepth": 4}, "datasets": {"requiredMetadata": ["license"]}}


@pytest.fixture
def preset_rules(monkeypatch):
    monkeypatch.setattr(krules, "_preset_rules", lambda preset, root: json.dumps(PRESET_RULES) if preset == "image-2d" else None)


def test_new_project_with_preset_stores_its_rules(client, preset_rules):
    r = client.post("/api/v1/projects", json={"title": "Chest", "preset": "preset:image-2d"})
    assert r.status_code == 201, r.text
    out = client.get(f"/api/v1/projects/{r.json()['id']}/rules").json()
    assert out["revision"] == 1 and out["source"] == "project" and out["rules"]["layout"]["maxDepth"] == 4
    assert len(client.get(f"/api/v1/projects/{r.json()['id']}/rules/history").json()["history"]) == 1


def test_first_boot_with_preset_stores_its_rules(client, preset_rules):
    pid = client.post("/api/v1/projects", json={"title": "Boot"}).json()["id"]
    with kdb.session_scope() as db:
        assert db.get(ProjectRules, pid) is None
    r = client.post(f"/api/v1/projects/{pid}/boots", json={"bootId": "boot-rules-1", "preset": "preset:image-2d"})
    assert r.status_code in (200, 201, 202), r.text
    out = client.get(f"/api/v1/projects/{pid}/rules").json()
    assert out["revision"] == 1 and out["rules"]["datasets"]["requiredMetadata"] == ["license"]


def test_project_create_dry_run_and_idempotency(client):
    r = client.post("/api/v1/projects?dryRun=true", json={"title": "Ghost"})
    assert r.status_code == 201 and r.json()["dryRun"] is True
    assert all(x["title"] != "Ghost" for x in client.get("/api/v1/projects").json()["projects"])
    h = {"Idempotency-Key": "prj-1"}
    a = client.post("/api/v1/projects", json={"title": "Once"}, headers=h)
    b = client.post("/api/v1/projects", json={"title": "Once"}, headers=h)
    assert a.json()["id"] == b.json()["id"]


# ---- Dataset commits carry the rules -------------------------------------------------------------


def test_commit_contains_studio_rules_json(vc):  # noqa: F811
    c = vc
    b = work(c, ALICE)
    r = save(c, ALICE, b, [])
    assert r.status_code == 201, r.text
    oid = r.json()["commit_oid"]
    files = fake_studio_files(c, oid)
    assert studio_defs.RULES_PATH in files
    assert json.loads(files[studio_defs.RULES_PATH])["version"] == 1
    st = c.get("/api/v1/datasets/ds/studio", params={"ref": oid}, headers=ALICE).json()
    assert st["rules"]["version"] == 1


def fake_studio_files(c, oid: str) -> dict:
    from studio_api.kernel.versioning import client as vclient

    f = vclient.client()
    for repo_id, r in f.repos.items():  # type: ignore[attr-defined]
        if oid in r["commits"]:
            tree = r["commits"][oid].get("studio_tree")
            return dict(f.studio_trees.get(tree, {})) if tree else {}
    return {}
