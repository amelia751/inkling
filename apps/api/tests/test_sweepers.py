"""todo18 D6: housekeeping releases work that claimed a slot and died."""

from __future__ import annotations

from datetime import timedelta

from studio_api import db as kdb
from studio_api.kernel import sweepers
from studio_api.models import IdempotencyKey, ScheduledRun, now

from .conftest import worker_headers


def test_a_wedged_empty_trash_run_is_reclaimed_and_runs_again(client):
    period = now().strftime("%Y-%m-%d")
    with kdb.session_scope() as db:
        db.add(ScheduledRun(name="files.empty_trash", period=period, result={"state": "running"}, at=now() - timedelta(minutes=5)))
    wedged = client.post("/api/v1/worker/scheduled/files.empty_trash", json={}, headers=worker_headers()).json()
    assert wedged["ran"] is False
    with kdb.session_scope() as db:
        assert sweepers.reclaim_scheduled(db) == 0  # younger than 30 minutes: still its run
        assert sweepers.reclaim_scheduled(db, at=now() + timedelta(minutes=31)) == 1
    again = client.post("/api/v1/worker/scheduled/files.empty_trash", json={}, headers=worker_headers()).json()
    assert again["ran"] is True


def test_a_stuck_in_progress_idempotency_key_is_swept(client):
    with kdb.session_scope() as db:
        db.add(IdempotencyKey(key="k1", principal="user:a", op_id="op", body_hash="sha256:x", status="in_progress", created_at=now() - timedelta(minutes=11)))
        db.add(IdempotencyKey(key="k2", principal="user:a", op_id="op", body_hash="sha256:x", status="in_progress", created_at=now()))
        db.add(IdempotencyKey(key="k3", principal="user:a", op_id="op", body_hash="sha256:x", status="done", created_at=now() - timedelta(hours=1)))
    with kdb.session_scope() as db:
        assert sweepers.sweep_idempotency(db) == 1
    with kdb.session_scope() as db:
        assert db.get(IdempotencyKey, ("k1", "user:a")) is None
        assert db.get(IdempotencyKey, ("k2", "user:a")) is not None and db.get(IdempotencyKey, ("k3", "user:a")) is not None
