"""The organization audit log (todo9 Phases 3–10): `audit_events` rows for account actions.

Ids and non-clinical labels only (D11): targets are principals, org, project, invitation and
key ids, never file names or study descriptions. Workspace plugin actions keep their own
hash-chained log (`kernel/audit.py`).

    audit(db, ctx, "members.role_changed", target=membership_id, detail={"role": "admin"})
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import AuditEvent, new_id, now

SIGNED_IN = "auth.signed_in"
SIGNED_OUT = "auth.signed_out"
ORG_SWITCHED = "auth.org_switched"


def record_event(db: Session, *, org_id: str | None, actor: str, action: str, target: str | None = None, on_behalf_of: str | None = None, ip: str | None = None, user_agent: str | None = None, detail: dict[str, Any] | None = None) -> AuditEvent:
    """One audit row, for callers without a request context (the sign-in callback, events)."""
    row = AuditEvent(id=new_id(), org_id=org_id, actor=actor, on_behalf_of=on_behalf_of, action=action, target=target, ip=ip, user_agent=(user_agent or "")[:512] or None, detail=detail, at=now())
    db.add(row)
    db.flush()
    return row


def audit(db: Session, ctx: RequestContext, action: str, target: str | None = None, *, org_id: str | None = None, detail: dict[str, Any] | None = None) -> AuditEvent:
    """An audit row for the request's actor, in its organization (or `org_id`), with its IP."""
    return record_event(db, org_id=org_id or ctx.org_id, actor=ctx.principal, action=action, target=target, on_behalf_of=ctx.on_behalf_of, ip=ctx.client_ip, user_agent=ctx.user_agent, detail=detail)
