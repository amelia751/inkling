"""Audit API: append-only log of installer actions, tool invocations, permissions, spend."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import PluginAudit


def record(db: Session, ctx: RequestContext, action: str, target: str | None = None, before: Any = None, after: Any = None) -> PluginAudit:
    row = PluginAudit(actor_id=ctx.principal, workspace_id=ctx.workspace_id, action=action, target=target, before_ref=before, after_ref=after, correlation_id=ctx.correlation_id)
    db.add(row)
    db.flush()
    return row


def entries(db: Session, ctx: RequestContext, limit: int = 200, action: str | None = None) -> list[dict]:
    q = select(PluginAudit).where(PluginAudit.workspace_id == ctx.workspace_id)
    if action:
        q = q.where(PluginAudit.action == action)
    rows = db.scalars(q.order_by(PluginAudit.id.desc()).limit(limit)).all()
    return [
        {"id": r.id, "actor": r.actor_id, "action": r.action, "target": r.target, "before": r.before_ref, "after": r.after_ref, "correlationId": r.correlation_id, "at": r.timestamp.isoformat()}
        for r in rows
    ]
