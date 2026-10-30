"""JobQueue + EventBus (todo/done/todo3.md E.2): one job is leased by exactly one claimer, killed
workers' jobs come back, and the Redis ready list mirrors the claimable jobs (KEDA scales on
its length). Postgres runs with `<envPrefix>TEST_DATABASE_URL`, Redis with `<envPrefix>TEST_REDIS_URL`."""

from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, update

from studio_api import db as dbm
from studio_api import redis_client
from studio_api.kernel import queue
from studio_api.models import PluginEvent, PluginJob
from studio_api.config import env

from .conftest import mask_result, run_worker_once, worker_headers, ws
from .test_installer_flow import install

SEG = {"tool": "test.seg.segment_objects", "input": {"asset_id": "img/a.png"}}


def enqueue(c, n: int = 1, workspace: str = "ws-a", **headers) -> list[str]:
    return [c.post("/api/v1/commands", json=SEG, headers=ws(workspace, **headers)).json()["job"]["jobId"] for _ in range(n)]


def claim(c, worker: str = "w1") -> dict | None:
    return c.post("/api/v1/worker/claim", json={"workerId": worker}, headers=worker_headers()).json()["job"]


def expire_lease(job_id: str) -> None:
    with dbm.session_scope() as s:
        s.execute(update(PluginJob).where(PluginJob.job_id == job_id).values(lease_until=datetime.now(UTC) - timedelta(seconds=1), updated_at=datetime.now(UTC) - timedelta(minutes=1)))


# ---- The SQL queue -----------------------------------------------------------------------------


def test_a_lease_is_a_conditional_update_only_one_claimer_wins(registry_client, tmp_path):
    c = registry_client(database_url=f"sqlite:///{tmp_path / 'q.db'}")
    install(c, "ws-a", "test.seg")
    (job_id,) = enqueue(c)
    now = datetime.now(UTC)
    a, b = dbm._Session(), dbm._Session()  # two replicas that both read the job as queued
    try:
        ja, jb = a.get(PluginJob, job_id), b.get(PluginJob, job_id)
        assert queue.lease(a, ja, "replica-a", now)
        a.commit()
        assert not queue.lease(b, jb, "replica-b", now)
        b.commit()
    finally:
        a.close()
        b.close()
    with dbm.session_scope() as s:
        j = s.get(PluginJob, job_id)
        assert j.worker_id == "replica-a" and j.attempts == 1


def test_an_expired_lease_is_claimed_again_and_commits_once(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    (job_id,) = enqueue(c)
    assert claim(c, "dead-worker")["jobId"] == job_id
    assert claim(c, "w2") is None
    expire_lease(job_id)
    claim2, done = run_worker_once(c, mask_result(), worker="w2")
    assert claim2["job"]["jobId"] == job_id and claim2["job"]["attempts"] == 2 and done["state"] == "succeeded"
    late = c.post(f"/api/v1/worker/jobs/{job_id}/complete", json={"workerId": "dead-worker", "result": mask_result()}, headers=worker_headers())
    assert late.status_code == 404
    assert len(c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]) == 1


def test_release_hands_the_job_back_on_shutdown(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    (job_id,) = enqueue(c)
    claim(c, "w1")
    r = c.post(f"/api/v1/worker/jobs/{job_id}/release", json={"workerId": "w1"}, headers=worker_headers())
    assert r.status_code == 200 and r.json()["state"] == "queued" and r.json()["attempts"] == 0
    assert claim(c, "w2")["jobId"] == job_id


pg = pytest.mark.skipif(not (env("TEST_DATABASE_URL") or "").startswith("postgres"), reason="set <envPrefix>TEST_DATABASE_URL to a Postgres URL")


@pg
def test_concurrent_claims_on_postgres_skip_locked_rows(registry_client):
    c = registry_client()
    install(c, "ws-a", "test.seg")
    jobs = set(enqueue(c, 12))
    won: list[str] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(6)

    def replica(i: int) -> None:
        try:
            barrier.wait()
            while True:
                with dbm.session_scope() as s:
                    j = queue.backend().claim(s, f"r{i}", None)
                    if j is None:
                        return
                    won.append(j.job_id)
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=replica, args=(i,)) for i in range(6)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errors
    assert sorted(won) == sorted(jobs)  # every job exactly once


# ---- Redis ---------------------------------------------------------------------------------------


@pytest.fixture
def redis_client_(registry_client):
    url = env("TEST_REDIS_URL")
    if not url:
        pytest.skip("set <envPrefix>TEST_REDIS_URL to run the Redis queue / bus")

    def make(**kw):
        redis_client.reset()
        c = registry_client(redis_url=url, job_queue="redis", event_bus="redis", housekeeping_interval_s=1, **kw)
        redis_client.client().flushdb()
        return c

    yield make
    redis_client.reset()


def ready_len() -> int:
    return redis_client.client().llen(redis_client.key("jobs", "ready"))


def test_redis_ready_list_mirrors_queued_jobs(redis_client_):
    c = redis_client_()
    install(c, "ws-a", "test.seg")
    ids = enqueue(c, 3)
    assert ready_len() == 3  # what KEDA scales on
    enqueue(c, 1, **{"Idempotency-Key": "same"})
    enqueue(c, 1, **{"Idempotency-Key": "same"})
    assert ready_len() == 4  # a replayed key enqueues (and pushes) nothing
    first = claim(c)
    assert first["jobId"] == ids[0] and ready_len() == 3  # FIFO
    leases = redis_client.client().zrange(redis_client.key("jobs", "leases"), 0, -1)
    assert leases == [ids[0]]


def test_redis_reaper_requeues_a_killed_workers_job(redis_client_):
    c = redis_client_()
    install(c, "ws-a", "test.seg")
    (job_id,) = enqueue(c)
    assert claim(c, "killed")["jobId"] == job_id and ready_len() == 0
    assert claim(c, "w2") is None
    expire_lease(job_id)
    redis_client.client().zadd(redis_client.key("jobs", "leases"), {job_id: 0})
    with dbm.session_scope() as s:
        assert queue.RedisJobQueue().reap(s) == 1
    assert ready_len() == 1
    claim2, done = run_worker_once(c, mask_result(), worker="w2")
    assert claim2["job"]["attempts"] == 2 and done["state"] == "succeeded"
    assert len(c.get("/api/annotations/ws-a", headers=ws("ws-a")).json()["annotations"]) == 1


def test_redis_reconciles_lost_pushes_and_drops_stale_ids(redis_client_):
    c = redis_client_()
    install(c, "ws-a", "test.seg")
    a, b = enqueue(c, 2)
    r = redis_client.client()
    r.delete(redis_client.key("jobs", "ready"))  # Redis restarted: the list is gone
    c.post(f"/api/v1/jobs/{b}/cancel", headers=ws("ws-a"))
    r.lpush(redis_client.key("jobs", "ready"), b, "no-such-job")
    expire_lease(a)  # backdate updated_at past the reconcile grace
    with dbm.session_scope() as s:
        assert queue.RedisJobQueue().reap(s) == 1
    assert claim(c)["jobId"] == a  # stale ids (cancelled, unknown) are skipped and dropped
    assert claim(c) is None and ready_len() == 0


def test_redis_event_bus_delivers_through_the_stream(redis_client_):
    c = redis_client_()
    install(c, "ws-a", "test.seg")
    enqueue(c)
    run_worker_once(c, mask_result())
    r = redis_client.client()
    assert r.xlen(redis_client.key("events")) >= 2  # job.succeeded + annotations.committed
    d = c.post("/api/v1/worker/events/deliver", headers=worker_headers()).json()
    assert d["delivered"] >= 2
    with dbm.session_scope() as s:
        assert all(e.delivered for e in s.scalars(select(PluginEvent)))
    pending = r.xpending(redis_client.key("events"), "kernel")
    assert pending["pending"] == 0  # acked after the commit
    assert c.post("/api/v1/worker/events/deliver", headers=worker_headers()).json()["delivered"] == 0
