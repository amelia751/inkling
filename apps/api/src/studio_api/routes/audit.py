"""Organization › Audit log (todo9 Phase 10): our `audit_events` table, newest first.

    GET /api/v1/org/audit?action=&actor=&before=&limit=50   (audit:read) → {events, next}
    GET /api/v1/org/audit.csv?action=&actor=                 (audit:read) → text/csv

Every account action lands here through `auth.audit` (sign-ins, org switches, sign-outs, members,
invitations, keys, security, profile). `actor` filters by principal, email or name (substring);
`action` by exact action, or a prefix ending in `.` (`members.`). `next` is an opaque cursor to
pass back as `before`; `before` also takes an ISO time.

Ids and non-clinical labels only (D11): the row's `detail` is never served or exported.
"""

from __future__ import annotations

import base64
import csv
import io
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from ..auth import current_org
from ..auth.permissions import AUDIT_READ, require_permission
from ..context import RequestContext
from ..db import get_session
from ..models import AuditEvent, User

router = APIRouter(prefix="/api/v1")

MAX_LIMIT = 200
CSV_MAX_ROWS = 50_000
CSV_COLUMNS = ("id", "at", "actorId", "actor", "action", "target", "ip")


def _iso(d: datetime) -> str:
    d = d if d.tzinfo else d.replace(tzinfo=UTC)
    return d.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _cursor(row: AuditEvent) -> str:
    return base64.urlsafe_b64encode(f"{_iso(row.at)}|{row.id}".encode()).decode().rstrip("=")


def _parse_before(before: str) -> tuple[datetime, str | None]:
    """An opaque `next` cursor (time + id), or a plain ISO time."""
    try:
        raw = base64.urlsafe_b64decode(before + "=" * (-len(before) % 4)).decode()
        at, rid = raw.split("|", 1)
        return datetime.fromisoformat(at.replace("Z", "+00:00")), rid
    except Exception:  # noqa: BLE001 — not a cursor: try an ISO time
        pass
    try:
        d = datetime.fromisoformat(before.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(422, "before must be a cursor from `next` or an ISO time") from None
    return (d if d.tzinfo else d.replace(tzinfo=UTC)), None


def _display(row: AuditEvent, user: User | None) -> str:
    if user is not None:
        name = " ".join(p for p in (user.first_name, user.last_name) if p)
        return name or user.email or row.actor
    return row.actor


def _query(db: Session, ctx: RequestContext, action: str | None, actor: str | None):
    org_id = current_org(db, ctx)
    scope = AuditEvent.org_id == org_id
    if ctx.org_id is None:
        # A dev identity: its own rows written before an organization was known count too.
        scope = or_(scope, and_(AuditEvent.org_id.is_(None), AuditEvent.actor == ctx.principal))
    q = select(AuditEvent, User).outerjoin(User, User.id == AuditEvent.actor).where(scope)
    if action:
        q = q.where(AuditEvent.action.startswith(action, autoescape=True) if action.endswith(".") else AuditEvent.action == action)
    if actor:
        like = f"%{actor.strip().lower()}%"
        q = q.where(or_(AuditEvent.actor.ilike(like), User.email.ilike(like), User.first_name.ilike(like), User.last_name.ilike(like), (User.first_name + " " + User.last_name).ilike(like)))
    return q.order_by(AuditEvent.at.desc(), AuditEvent.id.desc())


def _event(row: AuditEvent, user: User | None) -> dict[str, Any]:
    return {"id": row.id, "at": _iso(row.at), "actor": _display(row, user), "actorId": row.actor, "action": row.action, "target": row.target or "", "ip": row.ip}


@router.get("/org/audit")
def list_audit(action: str | None = None, actor: str | None = None, before: str | None = None, limit: int = Query(50, ge=1, le=MAX_LIMIT), ctx: RequestContext = Depends(require_permission(AUDIT_READ)), db: Session = Depends(get_session)):
    q = _query(db, ctx, action, actor)
    if before:
        at, rid = _parse_before(before)
        q = q.where(or_(AuditEvent.at < at, and_(AuditEvent.at == at, AuditEvent.id < rid)) if rid else AuditEvent.at < at)
    rows = db.execute(q.limit(limit + 1)).all()
    page = rows[:limit]
    return {"events": [_event(r, u) for r, u in page], "next": _cursor(page[-1][0]) if len(rows) > limit and page else None}


def _safe_cell(v: Any) -> str:
    """No spreadsheet formulas from audit text (CSV injection)."""
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


@router.get("/org/audit.csv")
def export_audit(action: str | None = None, actor: str | None = None, ctx: RequestContext = Depends(require_permission(AUDIT_READ)), db: Session = Depends(get_session)):
    rows = db.execute(_query(db, ctx, action, actor).limit(CSV_MAX_ROWS)).all()
    events = [_event(r, u) for r, u in rows]

    def lines() -> Iterator[str]:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(CSV_COLUMNS)
        for e in events:
            w.writerow([_safe_cell(e[c]) for c in CSV_COLUMNS])
            if buf.tell() > 64_000:
                yield buf.getvalue()
                buf.seek(0)
                buf.truncate()
        yield buf.getvalue()

    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(lines(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="audit-log-{stamp}.csv"', "Cache-Control": "no-store"})
