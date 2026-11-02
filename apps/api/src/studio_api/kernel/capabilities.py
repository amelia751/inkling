"""Worker capabilities (todo19 D10): which converters each worker has, kept in Postgres with a TTL.

A worker reports `{ffmpeg: "7.1", openslide: "4.0.1", pyvips: "8.18", …}` at start and again
while it runs (`POST /api/v1/workers/capabilities`). Reporting re-queues every `waiting`
derivative the new capabilities can serve, and (one-off, for rows from before `waiting` existed)
`failed` rows whose error says a tool "isn't installed". `live` is the union of unexpired reports.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..models import Derivative, WorkerCapability
from . import derivatives

TTL_S = 10 * 60


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(t: datetime) -> datetime:
    return t if t.tzinfo else t.replace(tzinfo=UTC)  # SQLite drops the zone


def kinds_for(caps: dict) -> list[str]:
    return [k for k, needs in derivatives.NEEDS.items() if any(caps.get(n) for n in needs)]


def report(db: Session, worker_id: str, caps: dict, *, ttl_s: int = TTL_S) -> int:
    """Upsert this worker's capabilities; returns how many derivatives were re-queued."""
    clean = {str(k): str(v) for k, v in (caps or {}).items() if v}
    row = db.get(WorkerCapability, worker_id)
    if row is None:
        row = WorkerCapability(worker_id=worker_id)
        db.add(row)
    row.capabilities, row.expires_at = clean, _now() + timedelta(seconds=ttl_s)
    db.flush()
    kinds = kinds_for(clean)
    if not kinds:
        return 0
    rows = db.scalars(
        select(Derivative)
        .where(Derivative.kind.in_(kinds))
        .where(or_(Derivative.state == "waiting", (Derivative.state == "failed") & Derivative.error.like("%isn't installed%")))
    ).all()
    for r in rows:
        r.state, r.attempts, r.progress, r.error, r.lease_until = "pending", 0, 0, None, None
    db.flush()
    return len(rows)


def live(db: Session, *, now: datetime | None = None) -> dict[str, str]:
    """Union of every unexpired worker's capabilities (name → version)."""
    t = now or _now()
    out: dict[str, str] = {}
    for r in db.scalars(select(WorkerCapability)):
        if _aware(r.expires_at) > t:
            out.update(r.capabilities or {})
    return out
