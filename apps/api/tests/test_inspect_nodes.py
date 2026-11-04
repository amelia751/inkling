"""todo28 W1: the worker posts each file as soon as it's checked (`POST …/imports/:id/nodes`);
the closing report doesn't re-apply them; a file still retrying stays `checking` and the sweeper
asks again (the worker side is in apps/worker/tests/test_inspection.py)."""

from __future__ import annotations

import hashlib
from datetime import timedelta

from sqlalchemy import select

from studio_api import db
from studio_api.kernel import sweepers
from studio_api.models import PluginEvent, SourceNode, now
from studio_api.routes.worker import worker_token

from .conftest import png

W = lambda: {"X-Worker-Token": worker_token()}  # noqa: E731


def _import(client, project_id: str, files: dict[str, bytes]) -> dict:
    body = {"attested": True, "files": [{"clientFileId": f"f{i}", "relPath": rel, "size": len(d), "sha256": hashlib.sha256(d).hexdigest()} for i, (rel, d) in enumerate(files.items())]}
    s = client.post(f"/api/v1/projects/{project_id}/imports", json=body).json()
    for f in s["files"]:
        if f["uploadUrl"]:
            client.put(f["uploadUrl"], content=next(d for rel, d in files.items() if rel.endswith(f["relPath"])))
    return client.post(f"/api/v1/imports/{s['id']}/complete").json()


def _setup(client):
    p = client.post("/api/v1/projects", json={"title": "Per file"}).json()["id"]
    imp = _import(client, p, {"a.png": png(4, 4), "b.png": png(5, 5), "c.png": png(6, 6)})
    files = {f["name"]: f["nodeId"] for f in client.get(f"/api/v1/worker/inspect/imports/{imp['id']}", headers=W()).json()["files"]}
    return p, imp, files


def _node(client, nid: str) -> dict:
    return client.get(f"/api/v1/source-nodes/{nid}").json()


def _events(type_: str) -> list[dict]:
    with db.session_scope() as s:
        return [e.payload for e in s.scalars(select(PluginEvent).where(PluginEvent.type == type_))]


def test_posted_nodes_apply_at_once_and_only_once(client):
    _p, imp, files = _setup(client)
    url = f"/api/v1/worker/inspect/imports/{imp['id']}/nodes"
    a = {"nodeId": files["a.png"], "detectedKind": "image", "facts": {"width": 4}, "flags": {}}
    assert client.post(url, json={"inspector": "v1", "nodes": [a]}).status_code == 401  # worker token only
    r = client.post(url, json={"inspector": "v1", "nodes": [a]}, headers=W()).json()
    assert r == {"state": "inspecting", "inspected": 1}
    assert _node(client, files["a.png"])["detectedKind"] == "image"
    assert _node(client, files["b.png"])["detectedKind"] is None  # its neighbours are still checking
    assert {"projectId": _p, "nodeIds": [files["a.png"]]} in _events("source.node.inspected")
    # Idempotent per node: the same inspector keeps the first result.
    again = client.post(url, json={"inspector": "v1", "nodes": [{**a, "facts": {"width": 99}}]}, headers=W()).json()
    assert again["inspected"] == 0 and _node(client, files["a.png"])["facts"]["width"] == 4
    # A new inspector version re-applies.
    assert client.post(url, json={"inspector": "v2", "nodes": [{**a, "facts": {"width": 7}}]}, headers=W()).json()["inspected"] == 1
    assert _node(client, files["a.png"])["facts"]["width"] == 7

    # The closing report: b is reported, a (sent again with other facts) is kept, c is retrying.
    rep = {"inspector": "v2", "nodes": [{**a, "facts": {"width": 1}}, {"nodeId": files["b.png"], "detectedKind": "image", "facts": {}, "flags": {}}], "retrying": [files["c.png"]]}
    done = client.post(f"/api/v1/worker/inspect/imports/{imp['id']}/report", json=rep, headers=W()).json()
    assert done["inspected"] == 1 and done["state"] in ("ready", "needs_review")
    assert _node(client, files["a.png"])["facts"]["width"] == 7
    c = _node(client, files["c.png"])
    assert c["detectedKind"] is None and c["flags"]["retrying"] is True and "unsupported" not in c["flags"]

    # After the import closed, only a retrying file may still be posted.
    late = {"inspector": "v2", "nodes": [{"nodeId": files["b.png"], "detectedKind": "unknown", "facts": {}, "flags": {}}]}
    assert client.post(url, json=late, headers=W()).json()["inspected"] == 0

    # The sweeper asks the worker again once the wait is over ...
    with db.session_scope() as s:
        assert sweepers.recheck_nodes(s) == 0  # not due yet
    with db.session_scope() as s:
        assert sweepers.recheck_nodes(s, at=now() + timedelta(minutes=5)) == 1
    asks = _events("source.node.recheck")
    assert asks == [{"projectId": _p, "importId": imp["id"], "nodeIds": [files["c.png"]]}]
    # ... and the recheck's post lands: no longer retrying.
    ok = {"inspector": "v2", "nodes": [{"nodeId": files["c.png"], "detectedKind": "image", "facts": {}, "flags": {}}]}
    assert client.post(url, json=ok, headers=W()).json()["inspected"] == 1
    c = _node(client, files["c.png"])
    assert c["detectedKind"] == "image" and "retrying" not in c["flags"] and "recheck" not in c["flags"]


def test_a_file_that_never_recovers_is_set_aside(client):
    _p, imp, files = _setup(client)
    nodes = [{"nodeId": files[n], "detectedKind": "image", "facts": {}, "flags": {}} for n in ("a.png", "b.png")]
    client.post(f"/api/v1/worker/inspect/imports/{imp['id']}/report", json={"inspector": "v1", "nodes": nodes, "retrying": [files["c.png"]]}, headers=W())
    at = now()
    for _ in range(sweepers.RECHECK_MAX + 1):
        at += timedelta(seconds=sweepers.RECHECK_MAX_WAIT_S + 1)
        with db.session_scope() as s:
            sweepers.recheck_nodes(s, at=at)
    with db.session_scope() as s:
        n = s.get(SourceNode, files["c.png"])
        assert n is not None and n.detected_kind == "unknown" and n.flags.get("unsupported") and not n.flags.get("retrying")
