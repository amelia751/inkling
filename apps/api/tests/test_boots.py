"""todo11 Milestone 2 (server): boots make drafts, the API enforces D2 for agents, and every
environment write is an `environment.updated` event on the project stream."""

from __future__ import annotations

from sqlalchemy import select

from studio_api import db as kdb
from studio_api.models import PluginEvent

from .conftest import png, ws
from .test_files import _by_name, _inspect_all, _new

LABELS5 = [{"name": "finding", "control": "Choices", "classes": [{"id": c} for c in ("normal", "pneumothorax", "effusion", "nodule", "cardiomegaly")]}]
REFINE = [{"op": "add", "path": "/labels", "value": LABELS5}, {"op": "add", "path": "/task", "value": "classification"}]


def _project(client, title="Chest") -> str:
    return client.post("/api/v1/projects", json={"title": title}, headers=ws("default")).json()["id"]


def _agent(client, scope: str, run="run_boot-1") -> dict:
    """The Studio mints this with the scope the person has open (a project, or a task)."""
    tok = client.post("/api/v1/sessions", json={"agent": "assistant", "profile": "assistant", "scopes": ["proposals.write"]}, headers=ws(scope)).json()["token"]
    return {"Authorization": f"Bearer {tok}", "X-Agent-Run": run}


def _events(project: str, types: tuple[str, ...]) -> list[tuple[str, dict]]:
    with kdb.session_scope() as s:
        rows = s.scalars(select(PluginEvent).where(PluginEvent.workspace_id == project, PluginEvent.type.in_(types)).order_by(PluginEvent.created_at)).all()
        return [(e.type, e.payload) for e in rows]


def test_an_agent_boots_a_draft_with_its_refinement_and_progress_events(client):
    p = _project(client)
    a = _agent(client, p)
    r = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-abc12345", "preset": "preset:image-2d", "patch": REFINE, "intent": "Create a chest X-ray Studio with five classification labels"}, headers=a)
    assert r.status_code == 202, r.text
    boot = r.json()
    assert boot["state"] == "ready" and boot["preset"] == "preset:image-2d" and len(boot["taskIds"]) == 1 and boot["ms"] >= 0
    assert boot["initiator"] == {"kind": "agent", "runId": "run_boot-1"}
    assert [s["step"] for s in boot["steps"]] == ["task", "environment", "refine"] and boot["steps"][-1]["label"] == "Added 5 labels, Set task"
    task = boot["taskIds"][0]

    # A draft, made for the person, with two revisions: the preset, then the model's patch.
    t = client.get(f"/api/v1/tasks/{task}").json()
    assert t["state"] == "draft" and t["bootId"] == "boot-abc12345"
    env = client.get(f"/api/environments/{task}").json()
    assert env["revision"] == 2 and env["environment"]["labels"] == LABELS5 and env["environment"]["extends"] == "preset:image-2d"
    hist = client.get(f"/api/environments/{task}/history").json()
    assert [h["environment"] for h in hist][0] == {"extends": "preset:image-2d"} and {h["authorKind"] for h in hist} == {"agent"}

    # The project stream has the contract's events, in order.
    evs = _events(p, ("boot.started", "boot.step", "boot.ready", "environment.updated"))
    assert [k for k, _ in evs] == ["boot.started", "boot.step", "environment.updated", "boot.step", "environment.updated", "boot.step", "boot.ready"]
    assert evs[0][1] == {"bootId": "boot-abc12345", "taskIds": [task], "preset": "preset:image-2d", "initiator": {"kind": "agent", "runId": "run_boot-1"}}
    upd = [pl for k, pl in evs if k == "environment.updated"]
    assert upd[0]["taskId"] == task and upd[0]["revision"] == 1 and "patch" not in upd[0]
    assert upd[1]["revision"] == 2 and upd[1]["patch"] == REFINE and upd[1]["author"] == "agent:run_boot-1" and upd[1]["runId"] == "run_boot-1"
    assert evs[-1][1]["taskIds"] == [task] and isinstance(evs[-1][1]["ms"], int)

    # Idempotent on bootId: a retry gets the same boot, nothing new is created.
    again = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-abc12345", "preset": "preset:image-2d", "patch": REFINE, "intent": "Create a chest X-ray Studio with five classification labels"}, headers=a)
    assert again.status_code == 202 and again.json()["taskIds"] == [task]
    assert client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-abc12345", "preset": "preset:video"}, headers=a).status_code == 409
    assert client.get("/api/v1/boots/boot-abc12345", headers=a).json()["state"] == "ready"
    datasets = client.get(f"/api/v1/projects/{p}/datasets").json()["datasets"]
    assert len(datasets) == 1


def test_an_agent_can_refine_its_draft_but_never_publish_it(client):
    p = _project(client)
    a = _agent(client, p)
    task = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-pub00001", "preset": "preset:image-2d"}, headers=a).json()["taskIds"][0]
    ok = client.patch(f"/api/environments/{task}", json={"revision": 1, "patch": REFINE}, headers=a)
    assert ok.status_code == 200 and ok.json()["revision"] == 2, ok.text
    # Stale revision → 409; no revision → 422.
    assert client.patch(f"/api/environments/{task}", json={"revision": 1, "patch": [{"op": "replace", "path": "/task", "value": "x"}]}, headers=a).status_code == 409
    assert client.patch(f"/api/environments/{task}", json={"patch": [{"op": "replace", "path": "/task", "value": "x"}]}, headers=a).status_code == 422
    # Can't publish (agent_scope refuses the route; the kernel refuses agents too).
    assert client.post(f"/api/v1/tasks/{task}/publish", headers=a).status_code == 403
    assert client.get(f"/api/v1/tasks/{task}").json()["state"] == "draft"
    # A person publishes.
    pub = client.post(f"/api/v1/tasks/{task}/publish")
    assert pub.status_code == 200 and pub.json()["state"] == "published"
    # Once published, an agent opened on the project (not this task) can no longer change it.
    assert client.patch(f"/api/environments/{task}", json={"revision": 2, "patch": [{"op": "replace", "path": "/task", "value": "x"}]}, headers=a).status_code == 403
    # Opened on the task by a person: it can.
    b = _agent(client, task, run="run_open-1")
    assert client.patch(f"/api/environments/{task}", json={"revision": 2, "patch": [{"op": "replace", "path": "/task", "value": "x"}]}, headers=b).status_code == 200


def test_agent_scope_is_enforced_by_the_api(client):
    p = _project(client)
    a = _agent(client, p)
    # Out-of-scope paths and uninstalled modules: 403, and the boot creates nothing.
    tools = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-scope001", "preset": "preset:image-2d", "patch": [{"op": "add", "path": "/tools", "value": []}]}, headers=a)
    assert tools.status_code == 403 and tools.json()["errors"][0]["code"] == "scope"
    mod = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-scope002", "preset": "preset:image-2d", "patch": [{"op": "add", "path": "/modules", "value": {"some.uninstalled": "^1"}}]}, headers=a)
    assert mod.status_code == 403
    task = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-scope003", "preset": "preset:image-2d", "patch": [{"op": "add", "path": "/modules", "value": {}}]}, headers=a)
    assert task.status_code == 403  # the whole map is never the agent's
    task = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-scope004", "preset": "preset:image-2d"}, headers=a).json()["taskIds"][0]
    bad = client.patch(f"/api/environments/{task}", json={"revision": 1, "patch": [{"op": "add", "path": "/modules/some.uninstalled", "value": "^1"}]}, headers=a)
    assert bad.status_code == 403 and "isn't installed" in bad.json()["errors"][0]["message"]
    # References: an unknown preset or renderer is a 422 with the PATCH error shape.
    ref = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-scope005", "preset": "preset:nope"}, headers=a)
    assert ref.status_code == 422 and ref.json()["errors"][0] == {"path": "/preset", "code": "reference", "message": ref.json()["errors"][0]["message"]}
    # The agent can't PUT, and can't create tasks the old way.
    assert client.put(f"/api/environments/{task}", json={"revision": 1, "environment": {"extends": "preset:image-2d"}}, headers=a).status_code == 403
    assert len(client.get(f"/api/v1/projects/{p}/datasets").json()["datasets"]) == 1
    # A person gets the same shape and reference checks.
    assert client.patch(f"/api/environments/{task}", json={"revision": 1, "patch": [{"op": "add", "path": "/viewports", "value": [{"name": "m", "renderer": "nope.renderers.x"}]}]}).status_code == 422
    # Another project's agent token can't boot here.
    other = _agent(client, _project(client, "Other"))
    assert client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-scope006", "preset": "preset:image-2d"}, headers=other).status_code == 404


def test_a_person_boots_with_files_and_bad_input_creates_nothing(client):
    p, _, imp = _new(client, {"xr/a.png": png(4, 4), "xr/b.png": png(5, 5)})
    _inspect_all(client, imp)
    n = _by_name(p)
    assert client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "short", "preset": "preset:image-2d"}).status_code == 422
    assert client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-files001", "preset": "preset:image-2d", "files": ["nod-missing"]}).status_code == 422
    before = len(client.get(f"/api/v1/projects/{p}/datasets").json()["datasets"])
    r = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-files002", "preset": "preset:image-2d", "folders": [n["xr"].id], "name": "X-rays"})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["initiator"] == {"kind": "person"} and [s["step"] for s in body["steps"]] == ["task", "files", "environment"] and body["steps"][1]["label"] == "Linked 2 files"
    task = body["taskIds"][0]
    assert client.get(f"/api/v1/tasks/{task}").json()["title"] == "X-rays"
    assert len(client.get(f"/api/v1/tasks/{task}/document").json()["assets"]) == 2
    assert len(client.get(f"/api/v1/projects/{p}/datasets").json()["datasets"]) == before + 1


def test_every_environment_write_is_an_event_on_the_project_stream(client):
    p, _, imp = _new(client, {"a.png": png(4, 4)})
    _inspect_all(client, imp)
    n = _by_name(p)
    ds = client.post(f"/api/v1/projects/{p}/datasets", json={"title": "S", "nodeIds": [n["a.png"].id], "task": {"title": "T", "preset": "preset:image-2d"}}).json()
    task = ds["tasks"][0]["id"]
    r = client.patch(f"/api/environments/{task}", json={"revision": 1, "patch": [{"op": "add", "path": "/task", "value": "detection"}]})
    assert r.status_code == 200, r.text
    upd = [pl for _, pl in _events(p, ("environment.updated",))]
    assert upd[-1] == {"taskId": task, "revision": 2, "author": "local-expert", "authorKind": "person", "contentHash": r.json()["contentHash"], "parentHash": upd[-1]["parentHash"], "patch": [{"op": "add", "path": "/task", "value": "detection"}]}
    # A PUT has no patch: clients refetch.
    client.put(f"/api/environments/{task}", json={"revision": 2, "environment": {"extends": "preset:image-2d"}})
    assert "patch" not in [pl for _, pl in _events(p, ("environment.updated",))][-1]


def test_a_boot_that_breaks_after_validation_is_recorded_as_failed(client, monkeypatch):
    from studio_api.kernel import projects as kprojects

    p = _project(client)

    def boom(*a, **k):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(kprojects, "create_task", boom)
    r = client.post(f"/api/v1/projects/{p}/boots", json={"bootId": "boot-fail0001", "preset": "preset:image-2d"})
    assert r.status_code == 500 and r.json()["boot"]["state"] == "failed" and "disk" not in r.text
    assert [k for k, _ in _events(p, ("boot.started", "boot.failed"))] == ["boot.failed"]
    assert client.get("/api/v1/boots/boot-fail0001").json()["error"]["step"] == "task"
    assert client.get(f"/api/v1/projects/{p}/datasets").json()["datasets"] == []
