"""`POST /v1/annotations`: the plugin SDK's `ctx.annotations.write` (todo2 Phase 6).

A direct write must keep the gateway's guarantees: scoped to a running job of the calling
plugin version, shape-checked, items inside the workspace, identity and provenance stamped
by the kernel, idempotent, and never able to overwrite someone else's annotations.
"""

from __future__ import annotations

from .conftest import worker_headers, ws
from .test_installer_flow import install


def claim_job(c, workspace="ws-a"):
    install(c, workspace, "test.seg")
    c.post("/api/v1/commands", json={"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}, headers=ws(workspace))
    claim = c.post("/api/v1/worker/claim", json={"workerId": "w1"}, headers=worker_headers()).json()
    assert claim["job"]
    return claim, {"Authorization": f"Bearer {claim['sessionToken']}", "X-Job-Id": claim["job"]["jobId"]}


def box(**over):
    return {"id": "b1", "itemId": "img/a.png", "label": "cell", "geometry": {"type": "box", "x": 1, "y": 2, "w": 3, "h": 4}, **over}


def test_plugin_writes_with_kernel_stamped_identity(registry_client):
    c = registry_client()
    claim, h = claim_job(c)
    r = c.post("/api/v1/annotations", json={"annotations": [box(author="alice", provenance="human-created")]}, headers={**h, "Idempotency-Key": "k1"})
    assert r.status_code == 200, r.text
    (aid,) = r.json()["annotationIds"]
    doc = c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]
    (a,) = [x for x in doc if x["id"] == aid]
    assert a["author"] == f"plugin:test.seg@{claim['plugin']['version']}" and a["provenance"] == "ai-suggested"
    assert a["attributes"]["job_id"] == claim["job"]["jobId"] and a["attributes"]["review_status"] == "pending"
    # Same key: a retry is a no-op.
    again = c.post("/api/v1/annotations", json={"annotations": [box()]}, headers={**h, "Idempotency-Key": "k1"})
    assert again.json()["annotationIds"] == [aid]
    assert len(c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]) == 1
    assert any(e["action"] == "annotations.commit" for e in c.get("/api/v1/audit", headers=ws("ws-a")).json()["entries"])


def test_plugin_cannot_overwrite_a_human_annotation(registry_client):
    c = registry_client()
    c.put("/api/annotations/ws-a", json={"revision": 0, "annotations": [{**box(id="human-1"), "provenance": "human-created", "author": "alice", "createdAt": "2026-01-01"}]}, headers=ws("ws-a"))
    _, h = claim_job(c)
    r = c.post("/api/v1/annotations", json={"annotations": [box(id="human-1", label="overwritten")]}, headers=h)
    assert r.status_code == 200
    doc = c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]
    human = next(a for a in doc if a["id"] == "human-1")
    assert human["label"] == "cell" and human["author"] == "alice" and len(doc) == 2


def test_malformed_or_foreign_annotations_are_rejected(registry_client):
    c = registry_client()
    _, h = claim_job(c)
    bad_mask = box(geometry={"type": "mask", "dims": [40, 30], "counts": [5, 5]})
    for body, status in [
        ({"annotations": [bad_mask]}, 422),
        ({"annotations": [box(itemId="img/b.png")]}, 422),  # an asset of ws-b, not ws-a
        ({"annotations": [box(geometry={"type": "interval", "lead": "I", "start": 0, "end": 1})]}, 422),  # legacy v1 type
        ({"annotations": [box(label="")]}, 422),
        ({"annotations": []}, 422),
    ]:
        r = c.post("/api/v1/annotations", json=body, headers=h)
        assert r.status_code == status, (body, r.text)
    assert c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"] == []


def test_write_needs_a_running_job_of_this_plugin_and_the_grant(registry_client):
    c = registry_client()
    claim, h = claim_job(c)
    assert c.post("/api/v1/annotations", json={"annotations": [box()]}, headers={"Authorization": h["Authorization"]}).status_code == 422
    assert c.post("/api/v1/annotations", json={"annotations": [box()]}, headers={**h, "X-Job-Id": "nope"}).status_code == 404
    # A workspace user (or an agent session) uses the document API, not this route.
    assert c.post("/api/v1/annotations", json={"annotations": [box()]}, headers={**ws("ws-a"), "X-Job-Id": claim["job"]["jobId"]}).status_code == 403
    # The plugin session can't replace the document or review annotations.
    assert c.put("/api/annotations/ws-a", json={"revision": 0, "annotations": []}, headers={"Authorization": h["Authorization"]}).status_code == 403
    assert c.post("/api/v1/annotations/x/review", json={"status": "accepted"}, headers={"Authorization": h["Authorization"]}).status_code == 403
    # Once the job is over, its token can't write any more.
    c.post(f"/api/v1/worker/jobs/{claim['job']['jobId']}/fail", json={"workerId": "w1", "error": "x", "recoverable": False}, headers=worker_headers())
    assert c.post("/api/v1/annotations", json={"annotations": [box()]}, headers=h).status_code == 409


def test_write_without_the_grant_is_denied(registry_client):
    c = registry_client()
    claim, h = claim_job(c)
    from studio_api import db as kdb
    from studio_api.context import issue_session

    with kdb.session_scope() as s:
        token = issue_session(s, f"plugin:test.seg@{claim['plugin']['version']}", "ws-a", ["assets.read"], profile="plugin")
    r = c.post("/api/v1/annotations", json={"annotations": [box()]}, headers={**h, "Authorization": f"Bearer {token}"})
    assert r.status_code == 403
