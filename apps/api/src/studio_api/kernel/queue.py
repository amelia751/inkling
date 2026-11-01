"""JobQueue (todo/done/todo3.md E.2): how workers find the next job. The DB row is always the
source of truth for a job's state; the queue only decides *which* job a claim looks at.

- `sql` (default): scan `plugin_jobs` for the oldest claimable row. On Postgres the scan
  takes row locks with `FOR UPDATE SKIP LOCKED`, so concurrent replicas never wait on or
  double-claim the same job; on every database the lease itself is a conditional UPDATE
  (state, lease and attempts must still be what was read), so SQLite is safe too.
- `redis`: a ready list per resource class of job ids (pushed after the enqueue commits;
  KEDA scales each worker pool on its lists' length): `<resourcePrefix>:jobs:ready` for `cpu`,
  `<resourcePrefix>:jobs:ready:<class>` for the others (`…:jobs:ready:gpu` for `worker-gpu`) and a lease set `<resourcePrefix>:jobs:leases`
  (job id → lease deadline). A reaper re-queues expired leases (a killed worker's job runs
  again; its idempotency key keeps the commit single) and reconciles the list with the DB,
  so a lost push or a Redis restart never strands a job.

Workers never talk to the queue: they claim over HTTP (`/api/v1/worker/claim`).

Fairness and scarce resources (todo12 §4 M0 items 3-4, docs/pipeline.md §11). Every job has a
resource class (`cpu`, `memory`, `gpu`); a claim names the classes its worker pool runs.
`workspace_resource_limits` caps how many jobs of a class a workspace runs at once (workspace
`*` is the default): the claim scan leaves out workspaces at their cap, so one workspace's
10,000 queued jobs don't hold back another's 20. `gpu` and `memory` jobs also take a
`resource_leases` row in the claim transaction; the heartbeat renews it and any terminal
state deletes it, and an expired or superseded lease counts for nothing (and is swept). On
Postgres the cap check for one (workspace, class) runs under a transaction-scoped advisory
lock, taken with `pg_try_advisory_xact_lock`, so two replicas can't both admit the last slot;
a replica that doesn't get the lock moves on to other jobs instead of waiting. The Redis path
checks the same Postgres caps; Redis is only the wake-up list, and when nothing it pops is
admissible the claim falls back to the capped SQL scan.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Protocol

from sqlalchemy import and_, delete, func, not_, or_, select, update
from sqlalchemy.orm import Session

from .. import aftercommit, redis_client
from ..config import settings
from ..models import PluginJob, ResourceLease, WorkspaceResourceLimit

log = logging.getLogger(__name__)

TERMINAL = {"succeeded", "failed", "cancelled"}
BUILTIN_TOOL = "__builtin__"
RESOURCE_CLASSES = ("cpu", "memory", "gpu")
LEASED_CLASSES = frozenset({"memory", "gpu"})  # these hold a `resource_leases` row while they run
DEFAULT_CLASSES = ("cpu", "memory")  # a claim that names no classes (a worker from before todo12)
DEFAULT_LIMIT = "*"


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


def lease_seconds(j: PluginJob, heartbeat: bool) -> int:
    """A worker that heartbeats gets a short lease it keeps renewing, so its death is noticed in
    `job_lease_s`; one that doesn't (older workers) gets a lease past the job's timeout."""
    return settings().job_lease_s if heartbeat else max(settings().job_lease_s, j.timeout_s + 30)


def lease(db: Session, j: PluginJob, worker_id: str, now: datetime, heartbeat: bool = False) -> bool:
    """Take the lease with a conditional UPDATE: only one claimer can win a given job. The new
    attempt number is the fencing token every later report must carry."""
    until = now + timedelta(seconds=lease_seconds(j, heartbeat))
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
    if j.resource_class in LEASED_CLASSES:
        db.execute(delete(ResourceLease).where(ResourceLease.job_id == j.job_id))
        db.add(ResourceLease(job_id=j.job_id, workspace_id=j.workspace_id, resource_class=j.resource_class, worker_id=worker_id, attempt=j.attempts, acquired_at=now, expires_at=until))
        db.flush()
    return True


def renew(db: Session, j: PluginJob, now: datetime) -> datetime:
    """Heartbeat: push the job's lease (and its resource lease) out; never shortens it."""
    until = now + timedelta(seconds=settings().job_lease_s)
    current = _aware(j.lease_until)
    if current is None or current < until:
        j.lease_until = until
    db.execute(update(ResourceLease).where(ResourceLease.job_id == j.job_id, ResourceLease.attempt == j.attempts).values(expires_at=_aware(j.lease_until)).execution_options(synchronize_session=False))
    return _aware(j.lease_until)  # type: ignore[return-value]


def release_resources(db: Session, job_id: str) -> None:
    db.execute(delete(ResourceLease).where(ResourceLease.job_id == job_id).execution_options(synchronize_session=False))


def sweep_leases(db: Session, now: datetime) -> int:
    """Reconcile: drop leases that expired, or whose job ended or moved on to another attempt."""
    live = select(PluginJob.job_id).where(PluginJob.job_id == ResourceLease.job_id, PluginJob.state == "running", PluginJob.attempts == ResourceLease.attempt)
    res = db.execute(delete(ResourceLease).where(or_(ResourceLease.expires_at < now, not_(live.exists()))).execution_options(synchronize_session=False))
    return int(res.rowcount or 0)  # type: ignore[attr-defined]


# ---- The fairness gate ---------------------------------------------------------------------


def _limits(db: Session, classes: tuple[str, ...]) -> tuple[dict[str, int], dict[tuple[str, str], int]]:
    """(default cap per class, cap per (workspace, class))."""
    defaults: dict[str, int] = {}
    own: dict[tuple[str, str], int] = {}
    for row in db.scalars(select(WorkspaceResourceLimit).where(WorkspaceResourceLimit.resource_class.in_(classes))):
        if row.workspace_id == DEFAULT_LIMIT:
            defaults[row.resource_class] = row.max_running
        else:
            own[(row.workspace_id, row.resource_class)] = row.max_running
    return defaults, own


def _running(db: Session, now: datetime, classes: tuple[str, ...], workspace_id: str | None = None) -> dict[tuple[str, str], int]:
    """How many jobs of each (workspace, class) hold a slot now: live leases for the leased
    classes, running jobs with an unexpired lease for the rest."""
    out: dict[tuple[str, str], int] = {}
    plain = [c for c in classes if c not in LEASED_CLASSES]
    leased = [c for c in classes if c in LEASED_CLASSES]
    if plain:
        q = select(PluginJob.workspace_id, PluginJob.resource_class, func.count()).where(PluginJob.state == "running", PluginJob.lease_until >= now, PluginJob.resource_class.in_(plain))
        if workspace_id is not None:
            q = q.where(PluginJob.workspace_id == workspace_id)
        out.update({(w, c): n for w, c, n in db.execute(q.group_by(PluginJob.workspace_id, PluginJob.resource_class))})
    if leased:
        q = (
            select(ResourceLease.workspace_id, ResourceLease.resource_class, func.count())
            .join(PluginJob, and_(PluginJob.job_id == ResourceLease.job_id, PluginJob.attempts == ResourceLease.attempt, PluginJob.state == "running"))
            .where(ResourceLease.expires_at >= now, ResourceLease.resource_class.in_(leased))
        )
        if workspace_id is not None:
            q = q.where(ResourceLease.workspace_id == workspace_id)
        out.update({(w, c): n for w, c, n in db.execute(q.group_by(ResourceLease.workspace_id, ResourceLease.resource_class))})
    return out


def _cap(defaults: dict[str, int], own: dict[tuple[str, str], int], workspace_id: str, cls: str) -> int | None:
    return own.get((workspace_id, cls), defaults.get(cls))


def blocked_clause(db: Session, now: datetime, classes: tuple[str, ...]):
    """A WHERE clause that leaves out every (workspace, class) already at its cap, or None."""
    defaults, own = _limits(db, classes)
    if not defaults and not own:
        return None
    running = _running(db, now, classes)
    full = [(w, c) for (w, c), n in running.items() if (cap := _cap(defaults, own, w, c)) is not None and n >= cap]
    full += [(w, c) for (w, c), cap in own.items() if cap <= 0 and (w, c) not in running]
    clauses = [and_(PluginJob.workspace_id == w, PluginJob.resource_class == c) for w, c in full]
    for c, cap in defaults.items():
        if cap <= 0:  # the class is closed except for workspaces with a cap of their own
            opened = [w for (w, cc), n in own.items() if cc == c and n > 0]
            clauses.append(and_(PluginJob.resource_class == c, PluginJob.workspace_id.not_in(opened) if opened else PluginJob.resource_class == c))
    return not_(or_(*clauses)) if clauses else None


def admit(db: Session, j: PluginJob, now: datetime) -> bool:
    """Is there a free slot for this job's (workspace, class)? Checked again for the one job
    about to be leased, under an advisory lock on Postgres (skipped, not awaited, if busy)."""
    defaults, own = _limits(db, (j.resource_class,))
    cap = _cap(defaults, own, j.workspace_id, j.resource_class)
    if cap is None:
        return True
    if db.get_bind().dialect.name == "postgresql":
        key = f"resource-slot:{j.workspace_id}:{j.resource_class}"
        if not db.scalar(select(func.pg_try_advisory_xact_lock(func.hashtextextended(key, 0)))):
            return False
    return _running(db, now, (j.resource_class,), j.workspace_id).get((j.workspace_id, j.resource_class), 0) < cap


def _give_up(db: Session, j: PluginJob) -> None:
    from . import jobs

    j.state, j.error, j.recoverable = "failed", f"gave up after {j.attempts} attempts", True
    jobs.settle(db, j, "worker_crash")


def _classes(classes: list[str] | None) -> tuple[str, ...]:
    picked = tuple(c for c in (classes or DEFAULT_CLASSES) if c in RESOURCE_CLASSES)
    return picked or DEFAULT_CLASSES


class JobQueue(Protocol):
    kind: str

    def push(self, job_ids: list[str], resource_class: str = "cpu") -> None: ...
    def claim(self, db: Session, worker_id: str, plugin_ids: list[str] | None, classes: list[str] | None = None, heartbeat: bool = False) -> PluginJob | None: ...
    def reap(self, db: Session) -> int: ...
    def depth(self) -> int | None: ...


class SqlJobQueue:
    kind = "sql"

    def push(self, job_ids: list[str], resource_class: str = "cpu") -> None:
        pass  # the table is the queue

    def claim(self, db: Session, worker_id: str, plugin_ids: list[str] | None, classes: list[str] | None = None, heartbeat: bool = False) -> PluginJob | None:
        """Oldest queued job of the worker's classes in a workspace under its cap, or a running
        one whose lease expired (its worker died)."""
        now = _now()
        cls = _classes(classes)
        if LEASED_CLASSES.intersection(cls):
            sweep_leases(db, now)
        q = select(PluginJob).where(_claimable_clause(now)).where(PluginJob.tool != BUILTIN_TOOL, PluginJob.resource_class.in_(cls))
        if plugin_ids:
            q = q.where(PluginJob.plugin_id.in_(plugin_ids))
        blocked = blocked_clause(db, now, cls)
        if blocked is not None:
            q = q.where(blocked)
        for j in db.scalars(_for_update(db, q.order_by(PluginJob.created_at).limit(10))).all():
            if j.attempts >= j.max_attempts:
                _give_up(db, j)
                continue
            if not admit(db, j, now):
                continue
            if lease(db, j, worker_id, now, heartbeat):
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
    POP_LIMIT = 50

    @property
    def ready(self) -> str:
        return self.ready_for("cpu")

    @staticmethod
    def ready_for(resource_class: str) -> str:
        return redis_client.key("jobs", "ready") if resource_class == "cpu" else redis_client.key("jobs", "ready", resource_class)

    @property
    def leases(self) -> str:
        return redis_client.key("jobs", "leases")

    def push(self, job_ids: list[str], resource_class: str = "cpu") -> None:
        if job_ids:
            redis_client.client().lpush(self.ready_for(resource_class), *job_ids)

    def depth(self) -> int | None:
        r = redis_client.client()
        return sum(int(r.llen(self.ready_for(c))) for c in RESOURCE_CLASSES)

    def claim(self, db: Session, worker_id: str, plugin_ids: list[str] | None, classes: list[str] | None = None, heartbeat: bool = False) -> PluginJob | None:
        r = redis_client.client()
        self.maybe_reap(db)
        now = _now()
        cls = _classes(classes)
        skipped: list[tuple[str, str]] = []
        won: PluginJob | None = None
        popped = 0
        lists = [self.ready_for(c) for c in cls]
        try:
            for i in range(self.POP_LIMIT):
                if not lists:
                    break
                name = lists[i % len(lists)]  # round-robin over this pool's classes
                jid = r.rpop(name)
                if jid is None:
                    lists.remove(name)
                    continue
                popped += 1
                j = db.scalar(_for_update(db, select(PluginJob).where(PluginJob.job_id == jid)))
                if j is None or j.tool == BUILTIN_TOOL or not _is_claimable(j, now):
                    continue  # stale or duplicate id: the DB says there's nothing to run
                if (plugin_ids and j.plugin_id not in plugin_ids) or j.resource_class not in cls:
                    skipped.append((name, jid))  # another worker pool's job: hand it back
                    continue
                if j.attempts >= j.max_attempts:
                    _give_up(db, j)
                    continue
                if not admit(db, j, now):
                    skipped.append((name, jid))  # its workspace is at its cap: hand it back
                    continue
                if lease(db, j, worker_id, now, heartbeat):
                    won = j
                    break
        finally:
            for name, jid in reversed(skipped):
                r.rpush(name, jid)  # back at the consuming end, in order
        if won is None and (skipped or popped >= self.POP_LIMIT):
            # Everything at the head of the list belongs to another pool or a capped workspace:
            # the capped SQL scan finds the next admissible job. Its id stays in the list and is
            # dropped as stale when it comes up.
            won = _sql.claim(db, worker_id, plugin_ids, list(cls), heartbeat)
        if won is not None:
            r.zadd(self.leases, {won.job_id: _aware(won.lease_until).timestamp()})  # type: ignore[union-attr]
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
        sweep_leases(db, now)
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
        ids = list(dict.fromkeys([*requeue, *claimable]))
        listed: set[str] = set()
        if ids:
            for c in RESOURCE_CLASSES:
                listed |= set(r.lrange(self.ready_for(c), 0, -1))
        missing = [jid for jid in ids if jid not in listed]
        if missing:
            by_class: dict[str, list[str]] = {}
            for jid, c in db.execute(select(PluginJob.job_id, PluginJob.resource_class).where(PluginJob.job_id.in_(missing))):
                by_class.setdefault(c or "cpu", []).append(jid)
            for c, group in by_class.items():
                r.lpush(self.ready_for(c), *sorted(group, key=missing.index))
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
        # Read the class at commit time: a service job's class is set after the enqueue.
        aftercommit.defer(db, lambda: q.push([job.job_id], job.resource_class or "cpu"))
