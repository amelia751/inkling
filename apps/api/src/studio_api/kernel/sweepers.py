"""todo18 D6: nothing waits forever. Housekeeping sweeps for work that claimed a slot and died:

- a scheduled run (`files.empty_trash`) left `{"state": "running"}` longer than
  `API_SCHEDULED_RECLAIM_MINUTES` is released, so the next worker ask runs it again;
- an `Idempotency-Key` left `in_progress` longer than `API_IDEMPOTENCY_STALL_MINUTES` is deleted,
  so a retry of the same request runs instead of answering 409 until the 24 h TTL.

Both are single UPDATE/DELETE statements guarded by the age, so every replica may run them.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import delete, null, select, update
from sqlalchemy.orm import Session

from ..config import settings
from ..models import IdempotencyKey, ScheduledRun, now

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


def run(db: Session) -> dict:
    return {"scheduled": reclaim_scheduled(db), "idempotency": sweep_idempotency(db)}
