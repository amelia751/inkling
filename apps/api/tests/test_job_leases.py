"""todo12 §4 M0 items 1-4: heartbeats renew the lease, reports are fenced by attempt, a cancel
reaches the worker as a 409, resource classes pick the worker pool, and the kernel fairness
gate (workspace caps, resource leases) holds on the SQL and the Redis queue.

Postgres runs with `<envPrefix>TEST_DATABASE_URL`, Redis with `<envPrefix>TEST_REDIS_URL`."""

from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from studio_api import db as dbm
from studio_api import redis_client
from studio_api.config import env
from studio_api.kernel import queue
from studio_api.models import PluginEvent, PluginJob, ResourceLease, WorkspaceResourceLimit

from .conftest import mask_result, worker_headers, ws
from .test_installer_flow import install

SEG = {"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}
W = "/api/v1/worker"


def enqueue(c, n: int = 1, workspace: str = "ws-a", resource_class: str | None = None) -> list[str]:
    body = {**SEG, "input": {"asset_id": "img/a.png" if workspace == "ws-a" else "img/b.png"}}
    ids = [c.post("/api/v1/commands", json=body, headers=ws(workspace)).json()["job"]["jobId"] for _ in range(n)]
    if resource_class:
        with dbm.session_scope() as s:
            s.execute(update(PluginJob).where(PluginJob.job_id.in_(ids)).values(resource_class=resource_class))
    return ids


def claim(c, worker: str = "w1", classes: list[str] | None = None, heartbeat: bool = True) -> dict | None:
    body: dict = {"workerId": worker, "heartbeat": heartbeat}
    if classes is not None:
        body["resourceClasses"] = classes
    return c.post(f"{W}/claim", json=body, headers=worker_headers()).json()["job"]


def beat(c, job: dict, worker: str = "w1", progress: float = 0.5):
    return c.post(f"{W}/jobs/{job['jobId']}/progress", json={"workerId": worker, "attempt": job["attempts"], "progress": progress}, headers=worker_headers())


def complete(c, job: dict, worker: str = "w1"):
    return c.post(f"{W}/jobs/{job['jobId']}/complete", json={"workerId": worker, "attempt": job["attempts"], "result": mask_result()}, headers=worker_headers())


def lease_of(job_id: str) -> datetime:
    with dbm.session_scope() as s:
        j = s.get(PluginJob, job_id)
        return j.lease_until if j.lease_until.tzinfo else j.lease_until.replace(tzinfo=UTC)


def expire(job_id: str) -> None:
    past = datetime.now(UTC) - timedelta(seconds=1)
    with dbm.session_scope() as s:
        s.execute(update(PluginJob).where(PluginJob.job_id == job_id).values(lease_until=past, updated_at=datetime.now(UTC) - timedelta(minutes=1)))
        s.execute(update(ResourceLease).where(ResourceLease.job_id == job_id).values(expires_at=past))


def set_limit(workspace: str, cls: str, n: int) -> None:
    with dbm.session_scope() as s:
        row = s.get(WorkspaceResourceLimit, (workspace, cls))
        if row is None:
            s.add(WorkspaceResourceLimit(workspace_id=workspace, resource_class=cls, max_running=n))
        else:
            row.max_running = n


def job_events(job_id: str) -> list[tuple[str, dict]]:
    with dbm.session_scope() as s:
        return [(e.type, e.payload) for e in s.scalars(select(PluginEvent).where(PluginEvent.type.in_(["job.succeeded", "job.failed"]))) if e.payload.get("job_id") == job_id]


# ---- Heartbeat and fencing ----------------------------------------------------------------------


def test_heartbeat_renews_the_short_lease(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    (job_id,) = enqueue(c)
    j = claim(c)
    assert j["jobId"] == job_id and j["attempts"] == 1
    first = lease_of(job_id)
    assert first - datetime.now(UTC) <= timedelta(seconds=61)  # a heartbeating worker's lease is job_lease_s
    with dbm.session_scope() as s:  # pretend the lease is about to run out
        s.execute(update(PluginJob).where(PluginJob.job_id == job_id).values(lease_until=datetime.now(UTC) + timedelta(seconds=2)))
    r = beat(c, j)
    assert r.status_code == 200 and r.json()["state"] == "running"
    assert lease_of(job_id) > datetime.now(UTC) + timedelta(seconds=50)
    assert complete(c, j).status_code == 200


def test_a_worker_without_heartbeats_keeps_the_long_lease(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    (job_id,) = enqueue(c)
    claim(c, heartbeat=False)
    with dbm.session_scope() as s:
        timeout = s.get(PluginJob, job_id).timeout_s
    assert lease_of(job_id) - datetime.now(UTC) > timedelta(seconds=timeout)


def test_a_worker_that_loses_its_lease_mid_job_cannot_report_success(registry_client):
    """Worker A stalls past its lease, B claims the job (attempt 2): A's heartbeat and its late
    result are refused with 409 and B's result is the one committed, once."""
    c = registry_client()
    install(c, "ws-a", "test.seg")
    (job_id,) = enqueue(c)
    a = claim(c, "a")
    assert beat(c, a, "a").status_code == 200
    expire(job_id)
    # The lease expired: even before anyone else claims it, A can't renew or finish.
    assert beat(c, a, "a").status_code == 409
    assert complete(c, a, "a").status_code == 409
    b = claim(c, "b")
    assert b["jobId"] == job_id and b["attempts"] == 2
    r = beat(c, a, "a")
    assert r.status_code == 409 and "lease lost" in r.json()["detail"]
    assert complete(c, a, "a").status_code == 409
    # Same worker id, stale attempt (a restarted worker reusing its name): still fenced.
    assert c.post(f"{W}/jobs/{job_id}/complete", json={"workerId": "b", "attempt": 1, "result": mask_result()}, headers=worker_headers()).status_code == 409
    assert c.post(f"{W}/jobs/{job_id}/fail", json={"workerId": "a", "attempt": 1, "error": "x"}, headers=worker_headers()).status_code == 409
    assert complete(c, b, "b").status_code == 200
    assert complete(c, a, "a").status_code == 409  # and after B finished
    assert len(c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]) == 1
    evs = job_events(job_id)
    assert [t for t, _ in evs] == ["job.succeeded"] and evs[0][1]["attempts"] == 2


def test_cancel_makes_the_next_heartbeat_a_409_and_publishes_job_failed(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    (job_id,) = enqueue(c)
    j = claim(c)
    assert beat(c, j).status_code == 200
    assert c.post(f"/api/v1/jobs/{job_id}/cancel", headers=ws("ws-a")).json()["state"] == "cancelled"
    r = beat(c, j)
    assert r.status_code == 409 and r.json()["detail"] == "job was cancelled"
    assert complete(c, j).status_code == 409
    ((kind, payload),) = job_events(job_id)
    assert kind == "job.failed" and payload["error_class"] == "cancelled" and payload["workspace_id"] == "ws-a"
    assert set(payload) >= {"job_id", "workspace_id", "idempotency_key", "attempts"}


def test_failures_carry_an_error_class(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    (job_id,) = enqueue(c)
    j = claim(c)
    r = c.post(f"{W}/jobs/{job_id}/fail", json={"workerId": "w1", "attempt": j["attempts"], "error": "timed out", "errorClass": "resource_exceeded"}, headers=worker_headers())
    assert r.status_code == 200 and r.json()["errorClass"] == "resource_exceeded"
    ((kind, payload),) = job_events(job_id)
    assert kind == "job.failed" and payload["error_class"] == "resource_exceeded"


# ---- Resource classes ------------------------------------------------------------------------------


def test_workers_claim_only_their_resource_classes(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    (gpu,) = enqueue(c, resource_class="gpu")
    (cpu,) = enqueue(c)
    assert claim(c, "cpu-1")["jobId"] == cpu  # default classes: cpu, memory
    assert claim(c, "cpu-2", ["cpu", "memory"]) is None
    g = claim(c, "gpu-1", ["gpu"])
    assert g["jobId"] == gpu and g["resourceClass"] == "gpu"


# ---- The fairness gate --------------------------------------------------------------------------


def test_claims_skip_a_workspace_at_its_cap(registry_client):
    """A has 10 queued jobs ahead of B's 2; with A capped at 1 running, B's jobs go next."""
    c = registry_client()
    install(c, "ws-a", "test.seg")
    install(c, "ws-b", "test.seg")
    a_ids = enqueue(c, 10, "ws-a")
    b_ids = enqueue(c, 2, "ws-b")
    set_limit("*", "cpu", 1)
    first = claim(c, "w1")
    assert first["jobId"] == a_ids[0]
    second = claim(c, "w2")
    assert second["jobId"] == b_ids[0]  # A is at its cap; B is under its own (the default, 1)
    assert claim(c, "w3") is None  # both at their caps
    set_limit("ws-b", "cpu", 2)  # a workspace's own row beats the default
    assert claim(c, "w3")["jobId"] == b_ids[1]
    assert complete(c, first, "w1").status_code == 200  # A's slot frees up
    assert claim(c, "w4")["jobId"] == a_ids[1]


def test_an_expired_lease_frees_its_slot(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    ids = enqueue(c, 2)
    set_limit("ws-a", "cpu", 1)
    j = claim(c, "dead")
    assert claim(c, "w2") is None
    expire(j["jobId"])
    again = claim(c, "w2")
    assert again["jobId"] == ids[0] and again["attempts"] == 2  # the stranded one first, oldest-first


def test_a_cap_of_zero_pauses_a_workspace(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    install(c, "ws-b", "test.seg")
    enqueue(c, 1, "ws-a")
    (b,) = enqueue(c, 1, "ws-b")
    set_limit("ws-a", "cpu", 0)
    assert claim(c)["jobId"] == b
    assert claim(c) is None
    set_limit("*", "cpu", 0)
    set_limit("ws-a", "cpu", 1)  # closed by default, open for A
    assert claim(c)["jobId"] != b


def test_gpu_jobs_hold_a_resource_lease_from_claim_to_terminal_state(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    ids = enqueue(c, 3, resource_class="gpu")
    set_limit("ws-a", "gpu", 2)
    g1, g2 = claim(c, "g1", ["gpu"]), claim(c, "g2", ["gpu"])
    assert claim(c, "g3", ["gpu"]) is None
    with dbm.session_scope() as s:
        leases = {r.job_id: r for r in s.scalars(select(ResourceLease))}
    assert set(leases) == {g1["jobId"], g2["jobId"]} and leases[g1["jobId"]].attempt == 1
    before = leases[g1["jobId"]].expires_at
    with dbm.session_scope() as s:
        s.execute(update(ResourceLease).where(ResourceLease.job_id == g1["jobId"]).values(expires_at=datetime.now(UTC) + timedelta(seconds=1)))
    assert beat(c, g1, "g1").status_code == 200  # the heartbeat renews the resource lease too
    with dbm.session_scope() as s:
        renewed = s.get(ResourceLease, g1["jobId"]).expires_at
    assert (renewed if renewed.tzinfo else renewed.replace(tzinfo=UTC)) > datetime.now(UTC) + timedelta(seconds=50)
    assert before is not None
    # Terminal states free the slot: success, failure, cancel.
    assert complete(c, g1, "g1").status_code == 200
    c.post(f"/api/v1/jobs/{g2['jobId']}/cancel", headers=ws("ws-a"))
    with dbm.session_scope() as s:
        assert list(s.scalars(select(ResourceLease))) == []
    g3 = claim(c, "g3", ["gpu"])
    assert g3["jobId"] == ids[2]


def test_an_expired_resource_lease_is_reconciled(registry_client):
    """A GPU worker dies: its lease row expires, stops counting, is swept, and the job runs again."""
    c = registry_client()
    install(c, "ws-a", "test.seg")
    (job_id,) = enqueue(c, 1, resource_class="gpu")
    set_limit("ws-a", "gpu", 1)
    claim(c, "dead", ["gpu"])
    expire(job_id)
    j = claim(c, "g2", ["gpu"])
    assert j["jobId"] == job_id and j["attempts"] == 2
    with dbm.session_scope() as s:
        (row,) = list(s.scalars(select(ResourceLease)))
        assert (row.worker_id, row.attempt) == ("g2", 2)


pg = pytest.mark.skipif(not (env("TEST_DATABASE_URL") or "").startswith("postgres"), reason="set <envPrefix>TEST_DATABASE_URL to a Postgres URL")


@pg
def test_concurrent_claims_never_exceed_a_cap_on_postgres(registry_client):
    """Eight replicas race for 20 jobs of one workspace capped at 3: never more than 3 run."""
    c = registry_client()
    install(c, "ws-a", "test.seg")
    enqueue(c, 20, resource_class="gpu")
    set_limit("ws-a", "gpu", 3)
    won: list[str] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(8)

    def replica(i: int) -> None:
        try:
            barrier.wait()
            for _ in range(5):
                with dbm.session_scope() as s:
                    j = queue.backend().claim(s, f"r{i}", None, ["gpu"], True)
                    if j is not None:
                        won.append(j.job_id)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=replica, args=(i,)) for i in range(8)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errors
    assert len(won) == 3 == len(set(won))
    with dbm.session_scope() as s:
        assert s.scalar(select(ResourceLease).where(ResourceLease.job_id == won[0])) is not None
        assert len(list(s.scalars(select(ResourceLease)))) == 3


# ---- Redis: the same Postgres caps -------------------------------------------------------------------


@pytest.fixture
def redis_kernel(registry_client):
    url = env("TEST_REDIS_URL")
    if not url:
        pytest.skip("set <envPrefix>TEST_REDIS_URL to run the Redis queue")

    def make(**kw):
        redis_client.reset()
        c = registry_client(redis_url=url, job_queue="redis", event_bus="redis", housekeeping_interval_s=1, **kw)
        redis_client.client().flushdb()
        return c

    yield make
    redis_client.reset()


def test_redis_claims_check_the_postgres_caps(redis_kernel):
    c = redis_kernel()
    install(c, "ws-a", "test.seg")
    install(c, "ws-b", "test.seg")
    a_ids = enqueue(c, 60, "ws-a")  # more than one pop batch ahead of B
    (b,) = enqueue(c, 1, "ws-b")
    set_limit("ws-a", "cpu", 1)
    assert claim(c, "w1")["jobId"] == a_ids[0]
    assert claim(c, "w2")["jobId"] == b  # found by the capped scan behind A's 59
    assert claim(c, "w3") is None
    ready = redis_client.client().llen(redis_client.key("jobs", "ready"))
    assert ready >= 59  # A's jobs were handed back, not dropped


def test_redis_ready_lists_are_per_class(redis_kernel):
    """KEDA scales `worker-gpu` on `<resourcePrefix>:jobs:ready:gpu` and the CPU pool on
    `…:jobs:ready` (cpu) plus `…:jobs:ready:memory`."""
    c = redis_kernel()
    install(c, "ws-a", "test.seg")
    enqueue(c, 3)
    r = redis_client.client()
    tok = {"Authorization": "Bearer dev-only-pipeline-token"}
    for i, cls in enumerate(("gpu", "memory")):
        assert c.post("/api/v1/service/jobs", json={"workspace_id": "ws-a", "kind": "noop", "input_ref": "x", "resource_class": cls, "idempotency_key": f"k{i}"}, headers=tok).status_code == 201
    assert r.llen(redis_client.key("jobs", "ready")) == 3
    assert r.llen(redis_client.key("jobs", "ready", "gpu")) == 1
    assert r.llen(redis_client.key("jobs", "ready", "memory")) == 1
    assert claim(c, "g1", ["gpu"])["resourceClass"] == "gpu"
    assert claim(c, "g2", ["gpu"]) is None
    assert {claim(c, "m", ["memory"])["resourceClass"]} == {"memory"}
    assert r.llen(redis_client.key("jobs", "ready", "gpu")) == 0
    # A lost push is repaired into the right list.
    r.delete(redis_client.key("jobs", "ready"))
    with dbm.session_scope() as s:
        s.execute(update(PluginJob).where(PluginJob.state == "queued").values(updated_at=datetime.now(UTC) - timedelta(minutes=1)))
    with dbm.session_scope() as s:
        assert queue.RedisJobQueue().reap(s) == 3
    assert r.llen(redis_client.key("jobs", "ready")) == 3
