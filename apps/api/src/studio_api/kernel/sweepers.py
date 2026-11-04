"""todo18 D6: nothing waits forever. Housekeeping sweeps for work that claimed a slot and died:

- a scheduled run (`files.empty_trash`) left `{"state": "running"}` longer than
  `API_SCHEDULED_RECLAIM_MINUTES` is released, so the next worker ask runs it again;
- an `Idempotency-Key` left `in_progress` longer than `API_IDEMPOTENCY_STALL_MINUTES` is deleted,
  so a retry of the same request runs instead of answering 409 until the 24 h TTL.

Both are single UPDATE/DELETE statements guarded by the age, so every replica may run them.

todo28 W1: a file whose bytes the worker couldn't read over HTTP (5 tries) is left `checking` with
`retrying: true` when its import closes. `recheck_nodes` asks the worker again
(`source.node.recheck`) with a growing wait (capped at an hour) until it succeeds. D3: there is no
"couldn't check, gave up" path; the file shows "Still checking (retrying)" and blocks nothing.
Content that really can't be read ends as unsupported through the normal inspection, not here.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import delete, null, select, update
from sqlalchemy.orm import Session

from ..config import settings
from ..models import IdempotencyKey, ImportSession, ScheduledRun, SourceNode, now

RUNNING = {"state": "running"}


def reclaim_scheduled(db: Session, at: datetime | None = None) -> int:
    at = at or now()
    cutoff = at - timedelta(minutes=settings().scheduled_reclaim_minutes)
    n = 0
    for r in db.scalars(select(ScheduledRun).where(ScheduledRun.at < cutoff).limit(200)):
        if r.result == RUNNING:
            n += db.execute(update(ScheduledRun).where(ScheduledRun.name == r.name, ScheduledRun.period == r.period, ScheduledRun.at == r.at).values(result=null(), at=at)).rowcount  # type: ignore[attr-defined]
    db.flush()
    return n


def sweep_idempotency(db: Session, at: datetime | None = None) -> int:
    at = at or now()
    cutoff = at - timedelta(minutes=settings().idempotency_stall_minutes)
    return db.execute(delete(IdempotencyKey).where(IdempotencyKey.status == "in_progress", IdempotencyKey.created_at < cutoff)).rowcount  # type: ignore[attr-defined]


RECHECK_MAX_WAIT_S = 3600


def recheck_nodes(db: Session, at: datetime | None = None) -> int:
    from . import events, inspection

    at = at or now()
    rows = db.execute(
        select(SourceNode, ImportSession.project_id)
        .join(ImportSession, ImportSession.id == SourceNode.import_session_id)
        .where(SourceNode.detected_kind.is_(None), SourceNode.is_dir.is_(False), SourceNode.trashed_at.is_(None), ImportSession.state.notin_(("uploading", "inspecting")))
        .limit(500)
    ).all()
    asks: dict[tuple[str, str], list[str]] = {}
    for n, project_id in rows:
        flags = dict(n.flags or {})
        rc = flags.get("recheck") if isinstance(flags.get("recheck"), dict) else {}
        if not flags.get("retrying"):
            continue
        due = str(rc.get("at") or "")
        if due and due > at.isoformat():
            continue
        attempt = int(rc.get("attempt") or 0) + 1
        wait_s = min(RECHECK_MAX_WAIT_S, inspection.RECHECK_FIRST_S * 2 ** min(attempt, 20))
        n.flags = {**flags, "recheck": {"attempt": attempt, "at": (at + timedelta(seconds=wait_s)).isoformat()}}
        asks.setdefault((project_id, str(n.import_session_id)), []).append(n.id)
    for (project_id, import_id), ids in asks.items():
        events.publish(db, inspection.service_context(project_id), "source.node.recheck", {"projectId": project_id, "importId": import_id, "nodeIds": ids}, source="kernel")
    db.flush()
    return sum(len(v) for v in asks.values())


def run(db: Session) -> dict:
    return {"scheduled": reclaim_scheduled(db), "idempotency": sweep_idempotency(db), "recheck": recheck_nodes(db)}
