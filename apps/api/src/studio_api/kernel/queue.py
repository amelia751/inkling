"""JobQueue (todo/todo3.md E.2): how workers find the next job. The DB row is always the
source of truth for a job's state; the queue only decides *which* job a claim looks at.

- `sql` (default): scan `plugin_jobs` for the oldest claimable row. On Postgres the scan
  takes row locks with `FOR UPDATE SKIP LOCKED`, so concurrent replicas never wait on or
  double-claim the same job; on every database the lease itself is a conditional UPDATE
  (state, lease and attempts must still be what was read), so SQLite is safe too.
- `redis`: a ready list `<resourcePrefix>:jobs:ready` of job ids (pushed after the enqueue
  commits; KEDA scales workers on its length) and a lease set `<resourcePrefix>:jobs:leases`
  (job id → lease deadline). A reaper re-queues expired leases (a killed worker's job runs
  again; its idempotency key keeps the commit single) and reconciles the list with the DB,
  so a lost push or a Redis restart never strands a job.

Workers never talk to the queue: they claim over HTTP (`/api/v1/worker/claim`).
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Protocol

from sqlalchemy import and_, or_, select, update
from sqlalchemy.orm import Session

from .. import aftercommit, redis_client
from ..config import settings
from ..models import PluginJob

log = logging.getLogger(__name__)

TERMINAL = {"succeeded", "failed", "cancelled"}
BUILTIN_TOOL = "__builtin__"


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(d: datetime | None) -> datetime | None:
    return d if d is None or d.tzinfo else d.replace(tzinfo=UTC)


def _claimable_clause(now: datetime):
    return or_(PluginJob.state == "queued", and_(PluginJob.state == "running", PluginJob.lease_until < now))


def _is_claimable(j: PluginJob, now: datetime) -> bool:
    lease = _aware(j.lease_until)
    return j.state == "queued" or (j.state == "running" and lease is not None and lease < now)


def _for_update(db: Session, q):
    return q.with_for_update(skip_locked=True) if db.get_bind().dialect.name == "postgresql" else q


def lease(db: Session, j: PluginJob, worker_id: str, now: datetime) -> bool:
    """Take the lease with a conditional UPDATE: only one claimer can win a given job."""
    until = now + timedelta(seconds=max(settings().job_lease_s, j.timeout_s + 30))
    seen = j.attempts
    res = db.execute(
        update(PluginJob)
        .where(PluginJob.job_id == j.job_id, PluginJob.attempts == seen, _claimable_clause(now))
        .values(state="running", worker_id=worker_id, attempts=seen + 1, lease_until=until, updated_at=now)
        .execution_options(synchronize_session=False)
    )
    if res.rowcount != 1:  # type: ignore[attr-defined]
        return False
    db.refresh(j)
    return True


def _give_up(j: PluginJob) -> None:
    j.state, j.error, j.recoverable = "failed", f"gave up after {j.attempts} attempts", True


class JobQueue(Protocol):
    kind: str

    def push(self, job_ids: list[str]) -> None: ...
    def claim(self, db: Session, worker_id: str, plugin_ids: list[str] | None) -> PluginJob | None: ...
    def reap(self, db: Session) -> int: ...
    def depth(self) -> int | None: ...


class SqlJobQueue:
    kind = "sql"

    def push(self, job_ids: list[str]) -> None:
        pass  # the table is the queue

    def claim(self, db: Session, worker_id: str, plugin_ids: list[str] | None) -> PluginJob | None:
        """Oldest queued job, or a running one whose lease expired (its worker died)."""
        now = _now()
        q = select(PluginJob).where(_claimable_clause(now)).where(PluginJob.tool != BUILTIN_TOOL)
        if plugin_ids:
            q = q.where(PluginJob.plugin_id.in_(plugin_ids))
        for j in db.scalars(_for_update(db, q.order_by(PluginJob.created_at).limit(10))).all():
            if j.attempts >= j.max_attempts:
                _give_up(j)
                continue
            if lease(db, j, worker_id, now):
                return j
        return None

    def reap(self, db: Session) -> int:
        return 0  # expired leases are claimable by the scan itself

    def depth(self) -> int | None:
        return None


class RedisJobQueue:
    kind = "redis"
    RECONCILE_MIN_AGE_S = 5
    SCAN_LIMIT = 1000

    @property
    def ready(self) -> str:
        return redis_client.key("jobs", "ready")

    @property
    def leases(self) -> str:
        return redis_client.key("jobs", "leases")

    def push(self, job_ids: list[str]) -> None:
        if job_ids:
            redis_client.client().lpush(self.ready, *job_ids)

    def depth(self) -> int | None:
        return int(redis_client.client().llen(self.ready))

    def claim(self, db: Session, worker_id: str, plugin_ids: list[str] | None) -> PluginJob | None:
        r = redis_client.client()
        self.maybe_reap(db)
        now = _now()
        skipped: list[str] = []
        won: PluginJob | None = None
        try:
            for _ in range(50):
                jid = r.rpop(self.ready)
                if jid is None:
                    break
                j = db.scalar(_for_update(db, select(PluginJob).where(PluginJob.job_id == jid)))
                if j is None or j.tool == BUILTIN_TOOL or not _is_claimable(j, now):
                    continue  # stale or duplicate id: the DB says there's nothing to run
                if plugin_ids and j.plugin_id not in plugin_ids:
                    skipped.append(jid)  # another worker pool's job: hand it back
                    continue
                if j.attempts >= j.max_attempts:
                    _give_up(j)
                    continue
                if lease(db, j, worker_id, now):
                    r.zadd(self.leases, {jid: _aware(j.lease_until).timestamp()})  # type: ignore[union-attr]
                    won = j
                    break
        finally:
            if skipped:
                r.rpush(self.ready, *reversed(skipped))  # back at the consuming end, in order
        return won

    def maybe_reap(self, db: Session) -> int:
        """Reap at most once per interval across all replicas (a short Redis lock)."""
        interval = max(1, int(settings().housekeeping_interval_s or 10))
        if not redis_client.client().set(redis_client.key("jobs", "reaper"), "1", nx=True, ex=interval):
            return 0
        return self.reap(db)

    def reap(self, db: Session) -> int:
        """Re-queue expired leases and any claimable job missing from the ready list."""
        r = redis_client.client()
        now = _now()
        requeue: list[str] = []
        for jid in r.zrangebyscore(self.leases, "-inf", now.timestamp()):
            j = db.get(PluginJob, jid)
            if j is None or j.state in TERMINAL or j.state == "queued":
                r.zrem(self.leases, jid)
                if j is not None and j.state == "queued":
                    requeue.append(jid)
            elif _is_claimable(j, now):
                r.zrem(self.leases, jid)
                requeue.append(jid)
            else:  # re-leased since: track the new deadline
                r.zadd(self.leases, {jid: _aware(j.lease_until).timestamp()})  # type: ignore[union-attr]
        # Reconcile: claimable in the DB but absent from the list (lost push, Redis restart,
        # a claim whose transaction rolled back after popping the id).
        settled = now - timedelta(seconds=self.RECONCILE_MIN_AGE_S)
        q = select(PluginJob.job_id).where(_claimable_clause(now), PluginJob.tool != BUILTIN_TOOL, PluginJob.updated_at < settled).order_by(PluginJob.created_at).limit(self.SCAN_LIMIT)
        claimable = list(db.scalars(q))
        listed = set(r.lrange(self.ready, 0, -1)) if claimable or requeue else set()
        missing = [jid for jid in dict.fromkeys([*requeue, *claimable]) if jid not in listed]
        if missing:
            r.lpush(self.ready, *missing)
            log.info("re-queued %d job(s)", len(missing), extra={"job_ids": missing[:20]})
        return len(missing)


_sql, _redis = SqlJobQueue(), RedisJobQueue()


def backend() -> JobQueue:
    return _redis if settings().job_queue == "redis" else _sql


def notify(db: Session, job: PluginJob) -> None:
    """A job became claimable in this transaction: tell the queue once it commits."""
    if job.tool == BUILTIN_TOOL:
        return
    q = backend()
    if q.kind != "sql":
        aftercommit.defer(db, q.push, [job.job_id])
