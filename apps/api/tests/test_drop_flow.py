"""todo28 W2: a drop is never one thing. Each file is routed into the drop's Studio as soon as it
is checked; a kind the Studio doesn't take waits and is said once; a file still checking or held
keeps nothing else out; the classifier only fast-paths where no assistant is in the loop."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from studio_api import db as kdb
from studio_api.kernel import drop_flags, drops_route
from studio_api.models import Drop, Organization, ProjectRow, SourceNode

from .conftest import png
from .test_drops import W, _drop, _events, _files, _project, _report

MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 32


@pytest.fixture(autouse=True)
def _fast_path_on():
    drop_flags.OVERRIDES.update(fast_path=True, auto_apply=False)
    yield
    drop_flags.OVERRIDES.clear()


def _boot(client, pid: str, drop_id: str, boot_id: str, **extra):
    return client.post(f"/api/v1/projects/{pid}/boots", json={"bootId": boot_id, "preset": "preset:image-2d", "accepts": ["image"], "dropId": drop_id, **extra})


def _names(client, task: str) -> list[str]:
    return sorted(a["name"] for a in client.get(f"/api/v1/tasks/{task}/document").json()["assets"])


def _node(pid: str, name: str) -> str:
    with kdb.session_scope() as db:
        return db.scalars(select(SourceNode.id).where(SourceNode.project_id == pid, SourceNode.name == name)).one()


def _checked(pid: str, name: str, kind: str = "image", **flags) -> None:
    """One file's own report (the worker's per-node post, W1): its kind, then routing."""
    nid = _node(pid, name)
    with kdb.session_scope() as db:
        n = db.get(SourceNode, nid)
        n.detected_kind, n.facts = kind, {**(n.facts or {}), "inspector": "test"}
        if flags:
            n.flags = {**(n.flags or {}), **flags}
        db.flush()
        drops_route.route_ready(db, pid, [nid])


def _summary(client, drop_id: str) -> dict:
    return client.get(f"/api/v1/drops/{drop_id}").json()["summary"]


def _state(client, drop_id: str, name: str) -> dict:
    return next(f for f in client.get(f"/api/v1/drops/{drop_id}").json()["files"] if f["name"] == name)


def test_a_studio_booted_with_the_drop_while_checking_gets_each_file_as_it_is_reported(client):
    pid = _project(client)
    files = {"a.png": png(8, 8), "b.png": png(9, 9), "c.png": png(10, 10)}
    drop, imp = _drop(client, pid, files)
    r = _boot(client, pid, drop["id"], "boot-flow-checking")
    assert r.status_code == 202, r.text
    task = r.json()["taskIds"][0]
    s = _summary(client, drop["id"])
    assert s["studioTaskId"] == task and s["checking"] == 3 and s["inStudio"] == 0 and s["ready"] == 0
    assert _names(client, task) == []  # nothing joins before its own check (D2)

    _checked(pid, "a.png")
    assert _names(client, task) == ["a.png"]
    assert _state(client, drop["id"], "a.png")["state"] == "in_studio"
    s = _summary(client, drop["id"])
    assert (s["inStudio"], s["checking"], s["ready"]) == (1, 2, 1)

    _checked(pid, "b.png")
    assert _names(client, task) == ["a.png", "b.png"]
    # The final report routes the rest and the drop settles; the classifier only suggests.
    _report(client, imp, {n: "image" for n in files})
    assert _names(client, task) == ["a.png", "b.png", "c.png"]
    s = _summary(client, drop["id"])
    assert (s["inStudio"], s["checking"], s["failed"], s["waitingForKind"]) == (3, 0, 0, {})
    assert s["groups"] and s["groups"][0]["suggestedAction"]
    settled = [p for t, p in _events(pid) if t == "drop.settled"]
    assert settled == [{"projectId": pid, "dropId": drop["id"], "conversationId": "conv-1", "inStudio": 3, "waitingForKind": {}, "failed": 0, "studioTaskId": task}]
    assert client.get(f"/api/v1/drops/{drop['id']}/plan").json()["state"] == "planned"  # never applied (D5)
    assert [t for t, _ in _events(pid) if t == "drop.applied"] == []


def test_a_kind_the_studio_doesnt_take_waits_and_is_said_once(client):
    pid = _project(client)
    files = {"a.png": png(8, 8), "clip1.mp4": MP4, "clip2.mp4": MP4 + b"\x01"}
    drop, imp = _drop(client, pid, files)
    task = _boot(client, pid, drop["id"], "boot-flow-kinds").json()["taskIds"][0]
    _checked(pid, "clip1.mp4", "video")
    _checked(pid, "a.png")
    _report(client, imp, {"a.png": "image", "clip1.mp4": "video", "clip2.mp4": "video"})
    # A later post of the same file says nothing new.
    with kdb.session_scope() as db:
        drops_route.route_ready(db, pid, [_node(pid, "clip2.mp4")])
    assert _names(client, task) == ["a.png"]
    waiting = [p for t, p in _events(pid) if t == "drop.kind_waiting"]
    assert len(waiting) == 1 and waiting[0]["kind"] == "video" and waiting[0]["count"] == 1
    s = _summary(client, drop["id"])
    assert s["waitingForKind"] == {"video": 2} and s["inStudio"] == 1 and s["ready"] == 3
    assert _state(client, drop["id"], "clip2.mp4")["state"] == "waiting_kind"
    # The agent service claims the milestones like the worker claims its events.
    types = ["drop.kind_waiting", "drop.files_failed", "drop.settled"]
    got = client.post("/api/v1/worker/subscriptions/claim", json={"subscriber": drops_route.SUBSCRIBER, "types": types}, headers=W()).json()["events"]
    assert [e["type"] for e in got] == ["drop.kind_waiting", "drop.settled"]
    client.post("/api/v1/worker/subscriptions/ack", json={"subscriber": drops_route.SUBSCRIBER, "eventIds": [e["eventId"] for e in got]}, headers=W())
    assert client.post("/api/v1/worker/subscriptions/claim", json={"subscriber": drops_route.SUBSCRIBER, "types": types}, headers=W()).json()["events"] == []


def test_one_file_stuck_checking_keeps_nothing_else_out(client):
    pid = _project(client)
    files = {"a.png": png(8, 8), "b.png": png(9, 9), "big.png": png(11, 11)}
    drop, _imp = _drop(client, pid, files)
    task = _boot(client, pid, drop["id"], "boot-flow-stuck").json()["taskIds"][0]
    _checked(pid, "a.png")
    _checked(pid, "b.png")
    with kdb.session_scope() as db:
        n = db.get(SourceNode, _node(pid, "big.png"))
        n.flags = {**(n.flags or {}), "retrying": True}
    assert _names(client, task) == ["a.png", "b.png"]
    s = _summary(client, drop["id"])
    assert (s["inStudio"], s["checking"], s["retrying"], s["failed"]) == (2, 1, 1, 0)
    big = _state(client, drop["id"], "big.png")
    assert big["state"] == "checking" and big["retrying"] is True


def test_a_privacy_held_file_never_joins(client):
    pid = _project(client)
    files = {"a.png": png(8, 8), "smith.png": png(9, 9)}
    drop, imp = _drop(client, pid, files)
    task = _boot(client, pid, drop["id"], "boot-flow-held").json()["taskIds"][0]
    files_ = client.get(f"/api/v1/worker/inspect/imports/{imp['id']}", headers=W()).json()["files"]
    nodes = [{"nodeId": f["nodeId"], "detectedKind": "image", "facts": {}, **({"flags": {"privacy": {"reason": "Burnt-in name"}}} if f["name"] == "smith.png" else {})} for f in files_]
    assert client.post(f"/api/v1/worker/inspect/imports/{imp['id']}/report", json={"inspector": "test", "nodes": nodes}, headers=W()).status_code == 200
    assert _names(client, task) == ["a.png"]
    assert _state(client, drop["id"], "smith.png")["state"] == "held"
    s = _summary(client, drop["id"])
    assert s["inStudio"] == 1 and s["ready"] == 1


def _files_drop(client, pid: str, files: dict[str, bytes]) -> tuple[dict, dict]:
    d = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "files", "files": len(files)}).json()
    imp = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "files": _files(files), "origin": {"kind": "files", "dropId": d["id"]}}).json()
    for f in imp["files"]:
        if f["uploadUrl"]:
            client.put(f["uploadUrl"], content=files[f["relPath"]])
    return d, client.post(f"/api/v1/imports/{imp['id']}/complete").json()


def test_drops_outside_a_conversation_and_orgs_without_the_assistant_still_fast_path(client):
    pid = _project(client)
    files = {"x1.png": png(8, 8), "x2.png": png(9, 9)}
    d, imp = _files_drop(client, pid, files)
    _report(client, imp, {n: "image" for n in files})
    plan = client.get(f"/api/v1/drops/{d['id']}/plan").json()
    assert plan["state"] == "applied" and plan["fastPath"] is True and len(plan["taskIds"]) == 1

    # A chat drop with the assistant on: classified, never applied (D5).
    chat, imp2 = _drop(client, pid, {"y.png": png(10, 10)}, conv="conv-2")
    _report(client, imp2, {"y.png": "image"})
    assert client.get(f"/api/v1/drops/{chat['id']}/plan").json()["state"] == "planned"

    # The same with the org's assistant off: the fast path places it.
    with kdb.session_scope() as db:
        org = db.get(Organization, db.get(ProjectRow, pid).org_id)
        org.ai_assist = False
    off, imp3 = _drop(client, pid, {"z.png": png(12, 12)}, conv="conv-3")
    _report(client, imp3, {"z.png": "image"})
    assert client.get(f"/api/v1/drops/{off['id']}/plan").json()["state"] == "applied"


def test_one_drop_one_studio_reattaching_elsewhere_is_refused_unless_moved(client):
    pid = _project(client)
    drop, imp = _drop(client, pid, {"a.png": png(8, 8)})
    _report(client, imp, {"a.png": "image"})
    first = _boot(client, pid, drop["id"], "boot-flow-first")
    assert first.status_code == 202
    task = first.json()["taskIds"][0]
    assert _names(client, task) == ["a.png"]  # a boot on a checked drop starts with its ready files
    with kdb.session_scope() as db:
        assert db.get(Drop, drop["id"]).task_id == task
    again = _boot(client, pid, drop["id"], "boot-flow-second")
    assert again.status_code == 409 and again.json()["taskId"] == task
    # A retry of the first boot is the same boot.
    assert _boot(client, pid, drop["id"], "boot-flow-first").status_code == 202
    moved = _boot(client, pid, drop["id"], "boot-flow-moved", moveDrop=True)
    assert moved.status_code == 202
    with kdb.session_scope() as db:
        assert db.get(Drop, drop["id"]).task_id == moved.json()["taskIds"][0]

    # A drop made inside an open Studio is attached from the start.
    inside = client.post(f"/api/v1/projects/{pid}/drops", json={"origin": "chat", "conversationId": "conv-9", "taskId": task, "files": 1}).json()
    s = client.post(f"/api/v1/projects/{pid}/imports", json={"attested": True, "taskId": task, "files": _files({"in.png": png(13, 13)}), "origin": {"kind": "chat", "conversationId": "conv-9", "dropId": inside["id"]}}).json()
    client.put(s["files"][0]["uploadUrl"], content=png(13, 13))
    s = client.post(f"/api/v1/imports/{s['id']}/complete").json()
    _report(client, s, {"in.png": "image"})
    assert "in.png" in _names(client, task)
    assert _summary(client, inside["id"])["studioTaskId"] == task


def test_the_agent_service_claims_the_drop_milestones_with_their_conversation(client):
    from studio_api.kernel import service_scope

    pid = _project(client)
    drop, imp = _drop(client, pid, {"a.png": png(8, 8), "clip.mp4": MP4}, conv="conv-wake")
    _boot(client, pid, drop["id"], "boot-flow-wake")
    _report(client, imp, {"a.png": "image", "clip.mp4": "video"})
    agent = {"Authorization": f"Bearer {service_scope.agent_token()}"}
    types = list(drops_route.MILESTONES)
    body = {"subscriber": drops_route.SUBSCRIBER, "types": types}
    got = client.post("/api/v1/worker/subscriptions/claim", json=body, headers=agent)
    assert got.status_code == 200, got.text
    evs = got.json()["events"]
    assert {e["type"] for e in evs} == {"drop.kind_waiting", "drop.settled"}
    assert all(e["payload"]["conversationId"] == "conv-wake" and e["payload"]["dropId"] == drop["id"] and e["payload"]["projectId"] == pid for e in evs)
    # Only `agent-drops`, only the milestones; no token, no claim.
    assert client.post("/api/v1/worker/subscriptions/claim", json={"subscriber": "inspect", "types": types}, headers=agent).status_code == 403
    assert client.post("/api/v1/worker/subscriptions/claim", json={**body, "types": ["source.uploaded"]}, headers=agent).status_code == 403
    assert client.post("/api/v1/worker/subscriptions/claim", json=body).status_code == 401
    other = client.post("/api/v1/worker/subscriptions/claim", json={"subscriber": "x", "types": ["drop.file"]}, headers=W()).json()["events"]
    assert client.post("/api/v1/worker/subscriptions/ack", json={"subscriber": drops_route.SUBSCRIBER, "eventIds": [other[0]["eventId"]]}, headers=agent).status_code == 403
    acked = client.post("/api/v1/worker/subscriptions/ack", json={"subscriber": drops_route.SUBSCRIBER, "eventIds": [e["eventId"] for e in evs]}, headers=agent)
    assert acked.status_code == 200 and acked.json()["acked"] == 2
    assert client.post("/api/v1/worker/subscriptions/claim", json=body, headers=agent).json()["events"] == []


def test_a_drop_outside_a_conversation_has_no_conversation_on_its_milestones(client):
    pid = _project(client)
    _d, imp = _files_drop(client, pid, {"x.png": png(8, 8)})
    _report(client, imp, {"x.png": "image"})
    (settled,) = [p for t, p in _events(pid) if t == "drop.settled"]
    assert "conversationId" not in settled
