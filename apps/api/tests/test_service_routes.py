"""todo12 §4 M0 items 5-6 and §5 contracts: the `service:pipeline` principal, its job routes and
the cross-workspace long-poll event feed. Postgres runs with `<envPrefix>TEST_DATABASE_URL`."""

from __future__ import annotations

import threading
import time

import pytest
from sqlalchemy import text

from studio_api import db as dbm
from studio_api.config import env
from studio_api.context import RequestContext
from studio_api.kernel import events, service_scope
from studio_api.routes import service as service_routes

from .conftest import worker_headers, ws

S = "/api/v1/service"


def svc() -> dict:
    return {"Authorization": f"Bearer {service_scope.pipeline_token()}"}


def job_body(**kw) -> dict:
    return {"workspace_id": "ws-a", "kind": "noop", "input_ref": "blob:x", "resource_class": "cpu", "idempotency_key": "run1/step1/p0", **kw}


def all_routes(app) -> set[tuple[str, str]]:
    """(method, path) of every route, through included routers whichever way FastAPI nests them."""
    out = set()
    stack = list(app.router.routes)
    while stack:
        r = stack.pop()
        inner = getattr(r, "original_router", None) or (r if hasattr(r, "routes") and not hasattr(r, "methods") else None)
        if inner is not None and inner is not r:
            stack.extend(inner.routes)
            continue
        for m in getattr(r, "methods", ()) or ():
            if m != "HEAD":
                out.add((m, r.path))
    return out


def fill(path: str) -> str:
    import re

    return re.sub(r"\{[^}:]+(:path)?\}", "x", path)


# ---- The principal ------------------------------------------------------------------------------


def test_the_pipeline_token_reaches_only_its_routes(client):
    """As agent_scope does for agents: every other registered route answers 403."""
    from studio_api.app import create_app

    app = create_app(init_db=False)
    routes = all_routes(app)
    allowed = service_scope.SERVICE_ROUTES[service_scope.PIPELINE]
    assert allowed <= routes
    # FastAPI's own docs pages are public and carry no data; every kernel route is checked.
    others = sorted(r for r in routes - allowed if r[1] not in ("/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"))
    assert len(others) > 100
    for method, path in others:
        r = client.request(method, fill(path), headers=svc())
        assert r.status_code == 403, (method, path, r.status_code)
    # And the allowed ones don't 403 on the principal (they may 404/422 on the filler ids).
    for method, path in allowed:
        assert client.request(method, fill(path), headers=svc(), json={}).status_code != 403, (method, path)


def test_service_routes_are_for_service_principals_only(client):
    assert client.get(f"{S}/events?wait=0", headers=ws("ws-a")).status_code == 401  # a person (dev headers)
    assert client.get(f"{S}/events?wait=0", headers={"Authorization": "Bearer nope"}).status_code == 403
    assert client.post(f"{S}/jobs", json=job_body(), headers=worker_headers()).status_code == 401  # the worker token isn't one


def test_production_without_a_token_has_no_pipeline_principal(make_client):
    c = make_client(env="production", worker_token="w", dev_trust_headers=False)
    assert service_scope.pipeline_token() is None
    assert c.get(f"{S}/events?wait=0", headers={"Authorization": f"Bearer {service_scope.DEV_PIPELINE_TOKEN}"}).status_code == 403
    c = make_client(env="production", worker_token="w", dev_trust_headers=False, pipeline_token="s3cret")
    assert c.get(f"{S}/events?wait=0", headers={"Authorization": "Bearer s3cret"}).status_code == 200


# ---- Jobs ------------------------------------------------------------------------------------------


def test_enqueue_is_idempotent_and_status_follows_the_job(client):
    r = client.post(f"{S}/jobs", json=job_body(), headers=svc())
    assert r.status_code == 201
    job_id = r.json()["job_id"]
    again = client.post(f"{S}/jobs", json=job_body(), headers=svc())
    assert again.status_code == 200 and again.json() == {"job_id": job_id}
    assert client.post(f"{S}/jobs", json=job_body(input_ref="blob:other"), headers=svc()).status_code == 409
    assert client.get(f"{S}/jobs/{job_id}", headers=svc()).json() == {"state": "queued", "attempts": 0}
    claim = client.post("/api/v1/worker/claim", json={"workerId": "w1", "heartbeat": True}, headers=worker_headers()).json()
    assert claim["builtin"] == "service" and claim["job"]["jobId"] == job_id and claim["job"]["input"] == {"inputRef": "blob:x"}
    done = client.post(f"/api/v1/worker/jobs/{job_id}/complete", json={"workerId": "w1", "attempt": 1, "result": {"result_ref": "blob:x"}}, headers=worker_headers())
    assert done.status_code == 200, done.text
    assert client.get(f"{S}/jobs/{job_id}", headers=svc()).json() == {"state": "succeeded", "attempts": 1, "result_ref": "blob:x"}
    feed = client.get(f"{S}/events?types=job.succeeded,job.failed&wait=0", headers=svc()).json()
    (ev,) = feed["events"]
    assert ev["type"] == "job.succeeded" and ev["workspace_id"] == "ws-a"
    p = ev["payload"]
    assert (p["job_id"], p["workspace_id"], p["idempotency_key"], p["attempts"], p["result_ref"]) == (job_id, "ws-a", "run1/step1/p0", 1, "blob:x")
    assert set(ev) == {"event_id", "workspace_id", "type", "source", "correlation_id", "depth", "idempotency_key", "payload", "payload_ref", "created_at"}


def test_enqueue_validates_its_input(client):
    for bad in (job_body(resource_class="tpu"), job_body(kind="unknown"), job_body(idempotency_key=""), job_body(workspace_id=None)):
        assert client.post(f"{S}/jobs", json=bad, headers=svc()).status_code == 422, bad
    assert client.post(f"{S}/jobs", json=job_body(workspace_id="nope"), headers=svc()).status_code == 404
    assert client.post(f"{S}/jobs", json=job_body(plugin="no.such.plugin"), headers=svc()).status_code == 403
    assert client.get(f"{S}/jobs/nope", headers=svc()).status_code == 404


def test_a_service_job_only_reads_jobs_it_enqueued(client):
    r = client.post("/api/v1/commands", json={"tool": "x.y", "input": {}}, headers=ws("ws-a"))
    assert r.status_code == 403  # nothing installed; just make sure a person's job isn't visible either
    from studio_api.models import PluginJob

    with dbm.session_scope() as s:
        s.add(PluginJob(job_id="theirs", workspace_id="ws-a", plugin_id="p", version="1", tool="t", input={}, state="queued", correlation_id="c", principal="user:a"))
    assert client.get(f"{S}/jobs/theirs", headers=svc()).status_code == 404


def test_the_kernel_retries_a_service_job_and_reports_only_the_last_outcome(client):
    job_id = client.post(f"{S}/jobs", json=job_body(), headers=svc()).json()["job_id"]
    for attempt in (1, 2, 3):
        c = client.post("/api/v1/worker/claim", json={"workerId": "w1", "heartbeat": True}, headers=worker_headers()).json()["job"]
        assert c["attempts"] == attempt
        r = client.post(f"/api/v1/worker/jobs/{job_id}/fail", json={"workerId": "w1", "attempt": attempt, "error": "503", "errorClass": "transient"}, headers=worker_headers())
        assert r.status_code == 200
        state = client.get(f"{S}/jobs/{job_id}", headers=svc()).json()
        assert state["state"] == ("failed" if attempt == 3 else "queued")
    assert state == {"state": "failed", "attempts": 3, "error_class": "transient"}
    evs = client.get(f"{S}/events?types=job.failed&wait=0", headers=svc()).json()["events"]
    assert len(evs) == 1 and evs[0]["payload"]["error_class"] == "transient" and evs[0]["payload"]["attempts"] == 3


def test_a_cancelled_service_job_reports_cancelled(client):
    job_id = client.post(f"{S}/jobs", json=job_body(), headers=svc()).json()["job_id"]
    client.post(f"/api/v1/jobs/{job_id}/cancel", headers=ws("ws-a"))
    assert client.get(f"{S}/jobs/{job_id}", headers=svc()).json() == {"state": "cancelled", "attempts": 0, "error_class": "cancelled"}


# ---- The feed -------------------------------------------------------------------------------------


def publish(workspace: str, type_: str = "job.succeeded", key: str | None = None) -> str:
    with dbm.session_scope() as s:
        ev = events.publish(s, RequestContext(workspace, "service:test", "c"), type_, {"n": key}, source="test", idempotency_key=key)
        assert ev is not None
        return ev.event_id


def test_the_feed_is_cross_workspace_ordered_and_resumable(client):
    a = publish("ws-a", key="1")
    b = publish("ws-b", key="2")
    publish("ws-a", "fs.changed", key="3")
    page = client.get(f"{S}/events?wait=0&types=job.succeeded&limit=1", headers=svc()).json()
    assert [e["event_id"] for e in page["events"]] == [a]
    page2 = client.get(f"{S}/events?wait=0&types=job.succeeded&after={page['cursor']}", headers=svc()).json()
    assert [e["event_id"] for e in page2["events"]] == [b]
    empty = client.get(f"{S}/events?wait=0&types=job.succeeded&after={page2['cursor']}", headers=svc()).json()
    assert empty["events"] == []
    everything = client.get(f"{S}/events?wait=0", headers=svc()).json()["events"]
    assert {e["type"] for e in everything} == {"job.succeeded", "fs.changed"}
    assert client.get(f"{S}/events?wait=0&after=garbage", headers=svc()).status_code == 422


def test_the_feed_long_polls_until_an_event_arrives(client, monkeypatch):
    monkeypatch.setattr(service_routes, "FEED_POLL_S", 0.05)
    cursor = client.get(f"{S}/events?wait=0", headers=svc()).json()["cursor"]
    t0 = time.monotonic()
    assert client.get(f"{S}/events?wait=0.5&after={cursor}", headers=svc()).json()["events"] == []
    assert 0.4 < time.monotonic() - t0 < 5
    threading.Timer(0.4, lambda: publish("ws-b", key="late")).start()
    t0 = time.monotonic()
    got = client.get(f"{S}/events?wait=10&after={cursor}", headers=svc()).json()
    assert [e["payload"]["n"] for e in got["events"]] == ["late"]
    assert time.monotonic() - t0 < 5


def test_publishing_is_limited_to_the_principals_types(client):
    body = {"workspace_id": "ws-a", "type": "job.succeeded", "payload": {}, "idempotency_key": "x"}
    assert client.post(f"{S}/events", json=body, headers=svc()).status_code == 403


pg = pytest.mark.skipif(not (env("TEST_DATABASE_URL") or "").startswith("postgres"), reason="set <envPrefix>TEST_DATABASE_URL to a Postgres URL")


@pg
def test_postgres_feed_never_skips_an_event_whose_transaction_commits_late(client):
    """T1 inserts first but commits after T2: the feed holds T2 back until T1 commits, so a
    consumer that read T2 can't have skipped T1."""
    cursor = client.get(f"{S}/events?wait=0", headers=svc()).json()["cursor"]
    slow = dbm._Session()
    try:
        events.publish(slow, RequestContext("ws-a", "service:test", "c"), "job.succeeded", {"n": "slow"}, source="test", idempotency_key="slow")
        slow.flush()  # T1 has its transaction id and its row, uncommitted
        publish("ws-b", key="fast")  # T2 commits
        page = client.get(f"{S}/events?wait=0&after={cursor}", headers=svc()).json()
        assert page["events"] == []  # held back below T1's horizon
        slow.commit()
    finally:
        slow.close()
    page = client.get(f"{S}/events?wait=0&after={cursor}", headers=svc()).json()
    assert [e["payload"]["n"] for e in page["events"]] == ["slow", "fast"]


@pg
def test_feed_seq_is_the_writing_transaction_id(client):
    publish("ws-a", key="k")
    with dbm.session_scope() as s:
        assert s.execute(text("SELECT count(*) FROM plugin_events WHERE feed_seq IS NULL")).scalar() == 0
