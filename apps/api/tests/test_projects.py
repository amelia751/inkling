"""todo6 Phase 1: projects, sources, datasets, tasks, proposals and resume."""

from __future__ import annotations

import hashlib

from studio_api import db as kdb
from studio_api.kernel import projects, tree
from studio_api.models import DatasetRow, ProjectRow, Source, SourceNode, TaskRow

from .conftest import png, ws

BOB = {"X-Dev-Principal": "user:bob"}


def test_seeds_become_projects_and_the_backfill_is_idempotent(client):
    listed = client.get("/api/v1/projects").json()["projects"]
    assert {p["id"] for p in listed} == {"ws-a", "ws-b"}
    assert all(p["sample"] for p in listed)
    with kdb.session_scope() as s:
        before = {m.__tablename__: s.query(m).count() for m in (ProjectRow, Source, SourceNode, DatasetRow, TaskRow)}
        # Startup ran once already; running again (another replica, a restart) adds nothing.
        projects.ensure_seeds(s)
        projects.ensure_seeds(s)
    with kdb.session_scope() as s:
        after = {m.__tablename__: s.query(m).count() for m in (ProjectRow, Source, SourceNode, DatasetRow, TaskRow)}
    assert before == after
    assert after["projects"] == after["datasets"] == after["tasks"] == after["sources"] == 2
    # One project, dataset and task per seed, all with the seed's id (todo6 D2).
    assert client.get("/api/v1/projects/ws-a/datasets/ws-a").json()["tasks"][0]["id"] == "ws-a"


def test_legacy_ids_still_serve_annotations_and_environments(client):
    doc = {"revision": 0, "annotations": [{"id": "x", "itemId": "img/a.png", "label": "l", "provenance": "human-created", "author": "me", "createdAt": "2026-10-30T00:00:00Z", "geometry": {"type": "box", "x": 1, "y": 1, "w": 2, "h": 2}}]}
    assert client.put("/api/annotations/ws-a", json=doc, headers=ws("ws-a")).status_code == 200
    assert [a["id"] for a in client.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]] == ["x"]
    r = client.put("/api/environments/ws-a", json={"revision": 0, "environment": {"extends": "preset:image-2d"}})
    assert r.status_code == 200 and r.json()["revision"] == 1
    assert client.get("/api/environments/ws-a").json()["environment"] == {"extends": "preset:image-2d"}
    # The task document of a seed is its manifest project, environment included.
    d = client.get("/api/v1/tasks/ws-a/document").json()
    assert d["id"] == "ws-a" and d["assets"][0]["path"] == "img/a.png" and d["environment"] == {"extends": "preset:image-2d"}


def test_new_tasks_have_their_own_documents(client):
    p = client.post("/api/v1/projects", json={"title": "Cardiac"}).json()
    assert p["id"].startswith("prj-") and not p["sample"]
    _import(client, p["id"], {"scans/a.png": png(8, 8), "scans/b.png": png(9, 9)})
    root = client.get(f"/api/v1/projects/{p['id']}/sources").json()["sources"][0]["rootNodeId"]
    ds = client.post(f"/api/v1/projects/{p['id']}/datasets", json={"title": "Scans", "nodeIds": [root], "task": {"title": "Outline", "preset": "preset:image-2d"}}).json()
    task = ds["tasks"][0]["id"]
    assert task.startswith("tsk-")
    # The Studio's legacy routes take the task id; the document lands in the project's workspace.
    doc = {"revision": 0, "annotations": []}
    assert client.put(f"/api/annotations/{task}", json=doc, headers=ws(task)).json()["revision"] == 1
    assert client.get(f"/api/environments/{task}").json()["effective"] == {"extends": "preset:image-2d"}
    assert client.get(f"/api/annotations/{p['id']}", headers=ws(p["id"])).json()["revision"] == 0
    # Uploaded files are "Checking…" until inspected, so the task document has no items yet.
    assert client.get(f"/api/v1/tasks/{task}/document").json()["assets"] == []


def test_projects_are_isolated_between_people(client):
    p = client.post("/api/v1/projects", json={"title": "Private"}).json()
    _import(client, p["id"], {"x/a.png": png(4, 4)})
    src = client.get(f"/api/v1/projects/{p['id']}/sources").json()["sources"][0]
    assert p["id"] not in {x["id"] for x in client.get("/api/v1/projects", headers=BOB).json()["projects"]}
    for url in (f"/api/v1/projects/{p['id']}", f"/api/v1/projects/{p['id']}/sources", f"/api/v1/sources/{src['id']}/children", f"/api/v1/source-nodes/{src['rootNodeId']}", f"/api/v1/projects/{p['id']}/overview"):
        assert client.get(url, headers=BOB).status_code == 404, url
    assert client.post(f"/api/v1/projects/{p['id']}/imports", json={"files": []}, headers=BOB).status_code == 404
    # Samples are shared with everyone.
    assert client.get("/api/v1/projects/ws-a", headers=BOB).status_code == 200


def test_children_paging_natural_sort_sequences_and_compact_chains(client):
    p = client.post("/api/v1/projects", json={"title": "Big"}).json()
    files = {f"study/MRI/patient_002/scan{i}.dcm": f"dcm{i}".encode() for i in (1, 2, 10, 120)}
    files |= {f"study/flat/item{i}.txt": f"t{i}".encode() for i in range(1, 1201)}
    files |= {"study/notes2.txt": b"a", "study/notes10.txt": b"b"}
    _import(client, p["id"], files)
    src = client.get(f"/api/v1/projects/{p['id']}/sources").json()["sources"][0]
    top = client.get(f"/api/v1/sources/{src['id']}/children").json()["items"]
    # Folders first; `MRI / patient_002` is one compact row; numbered names sort naturally.
    assert [i.get("displayPath") or i["name"] for i in top] == ["flat", "MRI / patient_002", "notes2.txt", "notes10.txt"]
    mri = top[1]
    scans = client.get(f"/api/v1/sources/{src['id']}/children", params={"node": mri["id"]}).json()["items"]
    assert len(scans) == 1 and scans[0]["kind"] == "sequence" and scans[0]["childCount"] == 4
    assert scans[0]["name"] == "scan1.dcm–scan120.dcm"
    run = client.get(f"/api/v1/sources/{src['id']}/children", params={"node": scans[0]["id"]}).json()["items"]
    assert [i["name"] for i in run] == ["scan1.dcm", "scan2.dcm", "scan10.dcm", "scan120.dcm"]
    # A folder of 1,200 runs-of-one isn't collapsed by accident: `item#.txt` collapses, so
    # check paging on the run itself (pages of at most 500).
    flat = top[0]
    seq = client.get(f"/api/v1/sources/{src['id']}/children", params={"node": flat["id"]}).json()["items"][0]
    page1 = client.get(f"/api/v1/sources/{src['id']}/children", params={"node": seq["id"]}).json()
    assert len(page1["items"]) == 500 and page1["total"] == 1200 and page1["nextCursor"] == "500"
    page3 = client.get(f"/api/v1/sources/{src['id']}/children", params={"node": seq["id"], "cursor": "1000"}).json()
    assert len(page3["items"]) == 200 and page3["nextCursor"] is None and page3["items"][-1]["name"] == "item1200.txt"


def test_natural_key_matches_finder():
    names = ["scan10", "scan2", "Scan1", "scan2b", "a"]
    assert sorted(names, key=tree.natural_key) == ["a", "Scan1", "scan2", "scan2b", "scan10"]


def test_agents_can_propose_but_never_confirm(client):
    p = client.post("/api/v1/projects", json={"title": "Mixed"}, headers=ws("default")).json()
    tok = client.post("/api/v1/sessions", json={"scopes": ["proposals.write"], "agent": "run-1"}, headers=ws(p["id"])).json()["token"]
    agent = {"Authorization": f"Bearer {tok}"}
    r = client.post(f"/api/v1/projects/{p['id']}/proposals", json={"kind": "relationship", "payload": {"summary": "link"}, "strength": "possible"}, headers=agent)
    assert r.status_code == 201, r.text
    pr = r.json()
    assert pr["createdBy"] == "agent:run-1" and pr["status"] == "proposed"
    assert client.post(f"/api/v1/proposals/{pr['id']}/confirm", json={}, headers=agent).status_code == 403
    assert client.post(f"/api/v1/proposals/{pr['id']}/dismiss", headers=agent).status_code == 403
    # The agent service names the run (todo6 Phase 6); only for agent tokens, and only a run id.
    r2 = client.post(f"/api/v1/projects/{p['id']}/proposals", json={"kind": "mapping", "payload": {}}, headers={**agent, "X-Agent-Run": "run_0f3a-9"}).json()
    assert r2["createdBy"] == "agent:run_0f3a-9"
    bad = client.post(f"/api/v1/projects/{p['id']}/proposals", json={"kind": "mapping", "payload": {}}, headers={**agent, "X-Agent-Run": "user:mallory"}).json()
    assert bad["createdBy"] == "agent:run-1"
    mine = client.post(f"/api/v1/projects/{p['id']}/proposals", json={"kind": "mapping", "payload": {}}, headers={"X-Agent-Run": "run_x"}).json()
    assert mine["createdBy"].startswith("user:")
    # A person can; the decision is audited and shows in Activity with the actor.
    assert client.post(f"/api/v1/proposals/{pr['id']}/confirm", json={}).json()["proposal"]["status"] == "confirmed"
    assert client.post(f"/api/v1/proposals/{pr['id']}/confirm", json={}).status_code == 409
    acts = [e["action"] for e in client.get(f"/api/v1/projects/{p['id']}/activity").json()["entries"]]
    assert "proposal.confirmed" in acts and "project.created" in acts


def test_resume_is_per_person_and_shows_on_overview(client):
    assert "resume" not in client.get("/api/v1/projects/ws-a/overview").json()
    r = client.put("/api/v1/projects/ws-a/resume", json={"taskId": "ws-a", "itemId": "img/a.png", "tool": "box", "placement": {"slice": 3}})
    assert r.json()["resume"]["itemId"] == "img/a.png"
    ov = client.get("/api/v1/projects/ws-a/overview").json()
    assert ov["resume"]["tool"] == "box" and ov["resume"]["placement"] == {"slice": 3}
    assert "resume" not in client.get("/api/v1/projects/ws-a/overview", headers=BOB).json()
    assert client.put("/api/v1/projects/ws-a/resume", json={"taskId": "ws-b"}).status_code == 422
    # Seeds: nothing needs attention, and the data cards are the seed's files by kind.
    assert "attention" not in ov and ov["data"][0]["kindLabel"] == "Image" and ov["data"][0]["count"] == 1


def test_uploads_verify_dedupe_and_resume(client):
    p = client.post("/api/v1/projects", json={"title": "Uploads"}).json()
    files = {"set/a.png": png(5, 5), "set/b.png": png(6, 6), "set/.DS_Store": b"junk"}
    body = _session_body(files)
    assert client.post(f"/api/v1/projects/{p['id']}/imports", json={**body, "attested": False}).status_code == 422
    s = client.post(f"/api/v1/projects/{p['id']}/imports", json=body).json()
    assert s["totals"]["skippedSystemFiles"] == 1 and len(s["files"]) == 2
    a = next(f for f in s["files"] if f["relPath"] == "a.png")
    # A damaged upload fails verification and can be retried.
    bad = client.put(a["uploadUrl"], content=b"x" * len(files["set/a.png"]))
    assert bad.json()["state"] == "failed"
    client.post(f"/api/v1/imports/{s['id']}/retry", json={})
    assert client.put(a["uploadUrl"], content=files["set/a.png"]).json()["state"] == "uploaded"
    # A reload: the same file list returns the same session, with a.png already there.
    again = client.post(f"/api/v1/projects/{p['id']}/imports", json=body).json()
    assert again["id"] == s["id"]
    b = next(f for f in again["files"] if f["relPath"] == "b.png")
    blob = files["set/b.png"]
    # In two chunks.
    assert client.put(b["uploadUrl"], content=blob[:10]).json()["received"] == 10
    assert client.put(b["uploadUrl"] + "?offset=10", content=blob[10:]).json()["state"] == "uploaded"
    done = client.post(f"/api/v1/imports/{s['id']}/complete").json()
    assert done["state"] == "inspecting" and done["totals"]["committed"] == 2
    # The tree mirrors the folder; nothing is viewable before inspection.
    src = client.get(f"/api/v1/projects/{p['id']}/sources").json()["sources"][0]
    kids = client.get(f"/api/v1/sources/{src['id']}/children").json()["items"]
    assert [k["name"] for k in kids] == ["a.png", "b.png"] and {k["status"] for k in kids} == {"checking"}
    # Re-dropping the folder adds nothing: everything is "Already in this project".
    re = client.post(f"/api/v1/projects/{p['id']}/imports", json=_session_body(files, prefix="r")).json()
    assert {f["state"] for f in re["files"]} == {"skipped_duplicate"} and re["sourceId"] == src["id"]
    assert len(client.get(f"/api/v1/projects/{p['id']}/sources").json()["sources"]) == 1


def test_events_publish_project_updates(client):
    p = client.post("/api/v1/projects", json={"title": "Live"}).json()
    _import(client, p["id"], {"d/a.png": png(4, 4)})
    from studio_api.models import PluginEvent

    with kdb.session_scope() as s:
        types = [e.type for e in s.query(PluginEvent).filter(PluginEvent.workspace_id == p["id"])]
    assert "import.updated" in types and "source.uploaded" in types


# ---- helpers ------------------------------------------------------------------------------------


def _session_body(files: dict[str, bytes], prefix: str = "f") -> dict:
    return {"attested": True, "files": [{"clientFileId": f"{prefix}{i}", "relPath": rel, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()} for i, (rel, data) in enumerate(files.items())]}


def _import(client, project_id: str, files: dict[str, bytes]) -> dict:
    s = client.post(f"/api/v1/projects/{project_id}/imports", json=_session_body(files)).json()
    for f in s["files"]:
        if f["uploadUrl"]:
            data = next(d for rel, d in files.items() if rel.endswith(f["relPath"]))
            assert client.put(f["uploadUrl"], content=data).json()["state"] == "uploaded"
    return client.post(f"/api/v1/imports/{s['id']}/complete").json()


