"""todo20 W4 (D8): a drop always ends in a state, and its findings are grouped by rule."""

from __future__ import annotations

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.models import ImportSession

from .conftest import png
from .test_drops import _drop, _events, _files, _project, _report


def _rules(client, pid: str, **sections) -> None:
    cur = client.get(f"/api/v1/projects/{pid}/rules").json()
    r = client.put(f"/api/v1/projects/{pid}/rules", json={"rules": {**cur["rules"], **sections}, "baseRevision": cur["revision"]})
    assert r.status_code == 200, r.text


def _new_drop(client, pid: str, n: int) -> dict:
    r = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "conv-1", "conversationTitle": "Scans", "files": n})
    assert r.status_code == 201, r.text
    return r.json()


def test_a_refused_import_fails_its_drop_at_once_with_grouped_findings(client):
    pid = _project(client)
    _rules(client, pid, layout={"fileNamePattern": r"[a-z0-9_]+\.png", "forbiddenCharacters": ":"}, enforce=["name.pattern"], severityOverrides={"name.pattern": "error"})
    files = {f"Batch:1/SCAN {i:02d}.png": png(4 + i, 4) for i in range(35)}
    drop = _new_drop(client, pid, len(files))
    r = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files(files), "origin": {"kind": "chat", "conversationId": "conv-1", "dropId": drop["id"]}})
    assert r.status_code == 422, r.text
    got = client.get(f"/api/v1/drops/{drop['id']}").json()
    assert got["state"] == "failed" and got["failure"]["step"] == "import"
    by = {(g["rule"], g["outcome"]): g for g in got["findings"]}
    refused = by[("name.pattern", "refused")]
    assert refused["count"] == 35 and len(refused["files"]) == 5 and refused["headline"].startswith("35 files: ") and refused["headline"].endswith("refused")
    renamed = by[("layout.forbidden-char", "renamed")]
    assert renamed["count"] == 35 and renamed["renamedTo"][0] == {"from": "Batch:1/SCAN 00.png", "to": "Batch_1/SCAN 00.png"}
    assert renamed["headline"].endswith("renamed automatically")
    assert ("drop.failed", {"projectId": pid, "dropId": drop["id"], "step": "import", "errorClass": "rejected"}) in _events(pid)
    # The agent's summary: counts and rules, never file names.
    from .test_drops import _agent

    summ = client.get(f"/api/v1/drops/{drop['id']}", headers=_agent(pid)).json()
    assert summ["state"] == "failed" and all("files" not in g and "renamedTo" not in g for g in summ["findings"])


def test_a_drop_whose_sessions_all_ended_is_ready(client):
    pid = _project(client)
    files = {f"x_{i}.png": png(5 + i, 5) for i in range(3)}
    drop, imp = _drop(client, pid, files)
    assert client.get(f"/api/v1/drops/{drop['id']}").json()["state"] == "inspecting"
    _report(client, imp, {n: "image" for n in files})
    # The classifier may move it on (planned/applied); it's never left uploading or inspecting.
    assert client.get(f"/api/v1/drops/{drop['id']}").json()["state"] in ("ready", "planned", "applied")


def test_a_drop_with_some_failed_files_is_partly_ready(client):
    pid = _project(client)
    files = {"a.png": png(6, 6), "b.png": png(7, 7)}
    drop = _new_drop(client, pid, 2)
    imp = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files(files), "origin": {"kind": "chat", "conversationId": "conv-1", "dropId": drop["id"]}}).json()
    f = next(x for x in imp["files"] if x["relPath"].endswith("a.png"))
    client.put(f["uploadUrl"], content=files["a.png"])
    imp = client.post(f"/api/v1/imports/{imp['id']}/complete").json()
    # b.png never arrived: the session ends with it pending, the drop settles once inspected.
    with kdb.session_scope() as db:
        from studio_api.kernel import drops as kdrops
        from studio_api.models import Drop, UploadFile

        for u in db.scalars(select(UploadFile).where(UploadFile.session_id == imp["id"], UploadFile.state == "pending")):
            u.state, u.reason = "failed", "The connection dropped. Retry"
        s = db.get(ImportSession, imp["id"])
        s.state = "ready"
        d = db.get(Drop, drop["id"])
        assert kdrops.settle(db, None, d) == "partly_ready"


def test_a_drop_whose_only_session_was_cancelled_is_failed(client):
    pid = _project(client)
    drop = _new_drop(client, pid, 1)
    imp = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files({"c.png": png(8, 8)}), "origin": {"kind": "chat", "conversationId": "conv-1", "dropId": drop["id"]}}).json()
    client.post(f"/api/v1/imports/{imp['id']}/cancel")
    got = client.get(f"/api/v1/drops/{drop['id']}").json()
    assert got["state"] == "failed" and got["failure"]["reason"] == "Cancelled"


def test_grouping_merges_and_caps_samples():
    from studio_api.kernel.drops import group_findings, merge_findings

    a = group_findings([{"rule": "r", "severity": "error", "message": "Bad name.", "file": f"f{i}"} for i in range(7)], refused=True)
    assert a == [{"rule": "r", "severity": "error", "outcome": "refused", "message": "Bad name.", "count": 7, "files": ["f0", "f1", "f2", "f3", "f4"], "headline": "7 files: bad name, refused"}]
    m = merge_findings(a, a)
    assert m[0]["count"] == 14 and len(m[0]["files"]) == 5 and m[0]["headline"].startswith("14 files")
