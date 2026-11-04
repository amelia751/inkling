"""todo20 D4/D5: a project has one default Studio and drops add to it; re-dropping known files
is never silent (`duplicate`, `new` / `alreadyHere`)."""

from __future__ import annotations

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.models import DropPlanRow, ProjectRow, TaskRow

from .test_drops import _drop, _project_without_assistant as _project, _report


def _tasks(pid: str) -> list[TaskRow]:
    with kdb.session_scope() as db:
        rows = list(db.scalars(select(TaskRow).where(TaskRow.project_id == pid)))
        for t in rows:
            db.expunge(t)
        return rows


def _applied(drop_id: str) -> dict:
    with kdb.session_scope() as db:
        row = db.get(DropPlanRow, drop_id)
        assert row is not None and row.state == "applied", row and (row.state, row.error)
        return dict(row.applied or {})


def _files(client, tid: str) -> list[str]:
    return sorted(a["name"] for a in client.get(f"/api/v1/tasks/{tid}/document").json()["assets"])


def test_first_drop_makes_the_default_studio_and_later_drops_add_to_it(client):
    pid = _project(client)
    drop, imp = _drop(client, pid, {"x/chest.png": b"png1"})
    _report(client, imp, {"chest.png": "image"})
    a = _applied(drop["id"])
    (t,) = _tasks(pid)
    assert t.title == "Studio" and a["outcome"] == "new_default_studio" and a["studioTaskId"] == t.id
    assert client.get(f"/api/v1/projects/{pid}").json()["defaultTaskId"] == t.id

    drop2, imp2 = _drop(client, pid, {"y/clip.mp4": b"mp4", "y/knee.png": b"png2"}, conv="conv-2")
    _report(client, imp2, {"clip.mp4": "video", "knee.png": "image"})
    a2 = _applied(drop2["id"])
    tasks = _tasks(pid)
    assert len(tasks) == 1 and a2["outcome"] == "add_to_studio" and a2["studioTaskId"] == t.id and a2["new"] == 2
    assert sorted(tasks[0].accepts) == ["image", "video"]
    assert _files(client, t.id) == ["chest.png", "clip.mp4", "knee.png"]
    env = client.get(f"/api/v1/tasks/{t.id}/document").json()["environment"]
    assert "preset:video" in (env["extends"] if isinstance(env["extends"], list) else [env["extends"]])


def test_an_all_duplicate_drop_is_duplicate_and_links_into_the_studio(client):
    pid = _project(client)
    drop, imp = _drop(client, pid, {"x/a.png": b"pngA", "x/b.png": b"pngB"})
    _report(client, imp, {"a.png": "image", "b.png": "image"})
    (t,) = _tasks(pid)
    # The Studio loses one file; dropping both again brings it back and says they were here.
    with kdb.session_scope() as db:
        from studio_api.kernel import collections
        from studio_api.models import DatasetRow

        d = db.get(DatasetRow, t.dataset_id)
        b = next(r["nodeId"] for r in d.definition["files"])
        collections.remove_files(db, d, [b])
    drop2, imp2 = _drop(client, pid, {"z/a.png": b"pngA", "z/b.png": b"pngB"}, conv="conv-2")
    _report(client, imp2, {"a.png": "image", "b.png": "image"})
    full = client.get(f"/api/v1/drops/{drop2['id']}").json()
    s = full["summary"]
    assert s["state"] == "duplicate" and s["alreadyHere"] == 2 and s["new"] == 0
    a2 = _applied(drop2["id"])
    assert a2["outcome"] == "add_to_studio" and a2["studioTaskId"] == t.id and a2["new"] == 1 and a2["alreadyHere"] == 1
    assert len(_tasks(pid)) == 1 and _files(client, t.id) == ["a.png", "b.png"]


def test_a_partly_duplicate_drop_counts_new_and_already_here(client):
    pid = _project(client)
    drop, imp = _drop(client, pid, {"x/a.png": b"pngA"})
    _report(client, imp, {"a.png": "image"})
    drop2, imp2 = _drop(client, pid, {"z/a.png": b"pngA", "z/c.png": b"pngC", "z/d.png": b"pngD"}, conv="conv-2")
    _report(client, imp2, {"a.png": "image", "c.png": "image", "d.png": "image"})
    s = client.get(f"/api/v1/drops/{drop2['id']}").json()["summary"]
    assert (s["new"], s["alreadyHere"]) == (2, 1) and s["state"] != "duplicate"
    a2 = _applied(drop2["id"])
    assert a2["outcome"] == "add_to_studio" and a2["new"] == 2 and a2["alreadyHere"] == 1
    assert len(_tasks(pid)) == 1


def test_a_drop_in_an_open_studio_adds_to_that_studio(client):
    from .test_drops import _files as files_body

    pid = _project(client)
    drop, imp = _drop(client, pid, {"x/a.png": b"pngA"})
    _report(client, imp, {"a.png": "image"})
    (default,) = _tasks(pid)
    other = client.post(f"/api/v1/projects/{pid}/boots", json={"bootId": "boot-other-1", "preset": "preset:image-2d", "name": "Other"}).json()["taskIds"][0]
    d = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "conv-3", "messageId": "msg-1", "taskId": other, "files": 1, "bytes": 4})
    assert d.status_code == 201, d.text
    s = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": files_body({"q/e.png": b"pngE"}), "origin": {"kind": "chat", "conversationId": "conv-3", "messageId": "msg-1", "dropId": d.json()["id"]}})
    assert s.status_code == 201, s.text
    for f in s.json()["files"]:
        client.put(f["uploadUrl"], content=b"pngE")
    imp2 = client.post(f"/api/v1/imports/{s.json()['id']}/complete").json()
    _report(client, imp2, {"e.png": "image"})
    a = _applied(d.json()["id"])
    assert a["outcome"] == "add_to_studio" and a["studioTaskId"] == other
    assert _files(client, other) == ["e.png"] and "e.png" not in _files(client, default.id)
    with kdb.session_scope() as db:
        assert db.get(ProjectRow, pid).default_task_id == default.id


def test_a_boot_can_add_to_an_existing_task(client):
    pid = _project(client)
    drop, imp = _drop(client, pid, {"x/a.png": b"pngA", "x/w.mp4": b"mp4"})
    _report(client, imp, {"a.png": "image", "w.mp4": "video"})
    tasks = _tasks(pid)
    (t,) = tasks
    from studio_api.models import SourceNode

    with kdb.session_scope() as db:
        node = db.scalar(select(SourceNode.id).where(SourceNode.project_id == pid, SourceNode.name == "w.mp4"))
    r = client.post(f"/api/v1/projects/{pid}/boots", json={"bootId": "boot-add-into-1", "preset": "preset:video", "addToTask": t.id, "files": [node]})
    assert r.status_code == 202, r.text
    assert r.json()["taskIds"] == [t.id] and len(_tasks(pid)) == 1
    bad = client.post(f"/api/v1/projects/{pid}/boots", json={"bootId": "boot-add-into-2", "preset": "preset:video", "addToTask": "tsk-nope"})
    assert bad.status_code == 422 and bad.json()["errors"][0]["path"] == "/addToTask"
