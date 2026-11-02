"""todo16 D9: an assistant turn is journaled in fs_batches and undone through the api."""

from __future__ import annotations

from studio_api import db as kdb
from studio_api.context import issue_session

from .conftest import png
from .test_files import ALICE, _by_name, _new
from .test_trash import _setup


def _agent(p: str, turn: str) -> dict:
    with kdb.session_scope() as db:
        token = issue_session(db, "agent:run_7", p, ["proposals.write", "project.write"], on_behalf_of=ALICE)
    return {"Authorization": f"Bearer {token}", "X-Turn-Id": turn}


def test_a_turn_is_listed_shown_in_activity_and_undone_newest_first(client):
    p, ds, _ = _setup(client)
    n = _by_name(p)
    agent = _agent(p, "turn-1")
    r = client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "rename", "nodeId": n["b.png"].id, "name": "c.png"}]}, headers=agent)
    assert r.status_code == 200, r.text
    r = client.delete(f"/api/v1/projects/{p}/datasets/{ds['id']}", headers=agent)
    assert r.status_code == 200, r.text

    t = client.get(f"/api/v1/projects/{p}/turns/turn-1", headers=agent).json()
    assert [b["kind"] for b in t["batches"]] == ["trash", "ops"] and t["undoable"] is True
    assert t["onBehalfOf"] == ALICE and "deleted dataset Scans" in t["summary"] and t["summary"].startswith("renamed")

    feed = client.get(f"/api/v1/projects/{p}/activity").json()["entries"]
    turn = [e for e in feed if e.get("kind") == "batch"]
    assert len(turn) == 1 and turn[0]["turnId"] == "turn-1" and turn[0]["undoable"] is True
    assert turn[0]["actorLabel"] == f"{ALICE.split(':')[-1]}'s assistant"
    assert not [e for e in feed if e.get("target") in {b["batchId"] for b in t["batches"]} and e.get("kind") != "batch"]

    out = client.post(f"/api/v1/projects/{p}/turns/turn-1/undo", headers=_agent(p, "turn-2"))
    assert out.status_code == 200, out.text
    assert out.json()["undone"] == 2
    assert client.get(f"/api/v1/projects/{p}/datasets/{ds['id']}").status_code == 200
    assert "b.png" in _by_name(p)
    feed = client.get(f"/api/v1/projects/{p}/activity").json()["entries"]
    assert [e["undoable"] for e in feed if e.get("kind") == "batch"] == [False]


def test_undo_refuses_when_a_later_change_touched_the_same_files(client):
    p, _, _ = _new(client, {"study/a.png": png(4, 4)})
    n = _by_name(p)["a.png"]
    agent = _agent(p, "turn-9")
    assert client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "rename", "nodeId": n.id, "name": "b.png"}]}, headers=agent).status_code == 200
    # The person renames it again afterwards.
    assert client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "rename", "nodeId": n.id, "name": "c.png"}]}).status_code == 200
    assert client.get(f"/api/v1/projects/{p}/turns/turn-9").json()["undoable"] is False
    r = client.post(f"/api/v1/projects/{p}/turns/turn-9/undo")
    assert r.status_code == 409, r.text
    assert "c.png" in _by_name(p)
    assert client.get(f"/api/v1/projects/{p}/turns/nope").status_code == 404


def test_latest_is_the_callers_previous_turn(client):
    p, _, _ = _new(client, {"study/a.png": png(4, 4)})
    n = _by_name(p)["a.png"]
    assert client.post(f"/api/v1/projects/{p}/fs/ops", json={"ops": [{"kind": "rename", "nodeId": n.id, "name": "b.png"}]}, headers=_agent(p, "turn-a")).status_code == 200
    asking = _agent(p, "turn-b")
    assert client.get(f"/api/v1/projects/{p}/turns/latest", headers=asking).json()["turnId"] == "turn-a"
    assert client.post(f"/api/v1/projects/{p}/turns/latest/undo", headers=asking).json()["undone"] == 1
    assert "a.png" in _by_name(p)
