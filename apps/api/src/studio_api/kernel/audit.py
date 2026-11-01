"""Audit API: append-only log of installer actions, tool invocations, permissions, spend.

Hash-chained per workspace (todo10 §3.4): each entry stores the previous entry's hash and its
own, `sha256` of the RFC 8785 form of its fields plus that previous hash, so editing, deleting
or reordering an entry breaks the chain from there on (`verify_chain`). Entries are chained
under a per-workspace lock (a transaction-scoped advisory lock on Postgres).
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import PluginAudit, now
from .canonical import content_hash


def _json(v: Any) -> Any:
    return None if v is None else json.loads(json.dumps(v, default=str))


def _iso(d: datetime) -> str:
    return (d if d.tzinfo else d.replace(tzinfo=UTC)).astimezone(UTC).isoformat(timespec="microseconds")


def entry_hash(r: PluginAudit) -> str:
    return content_hash({
        "prev": r.prev_hash, "actor": r.actor_id, "workspace": r.workspace_id, "action": r.action, "target": r.target,
        "before": r.before_ref, "after": r.after_ref, "correlation": r.correlation_id, "onBehalfOf": r.on_behalf_of, "at": _iso(r.timestamp),
    })


def _lock(db: Session, workspace_id: str) -> None:
    if db.get_bind().dialect.name == "postgresql":
        key = int(hashlib.sha256(f"audit:{workspace_id}".encode()).hexdigest()[:15], 16)
        db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": key})


def _last_hash(db: Session, workspace_id: str) -> str | None:
    return db.scalar(select(PluginAudit.entry_hash).where(PluginAudit.workspace_id == workspace_id, PluginAudit.entry_hash.is_not(None)).order_by(PluginAudit.id.desc()).limit(1))


def record(db: Session, ctx: RequestContext, action: str, target: str | None = None, before: Any = None, after: Any = None) -> PluginAudit:
    _lock(db, ctx.workspace_id)
    row = PluginAudit(actor_id=ctx.principal, workspace_id=ctx.workspace_id, action=action, target=target, before_ref=_json(before), after_ref=_json(after), correlation_id=ctx.correlation_id, on_behalf_of=ctx.on_behalf_of,
                      timestamp=now(), prev_hash=_last_hash(db, ctx.workspace_id))
    row.entry_hash = entry_hash(row)
    db.add(row)
    db.flush()
    return row


def verify_chain(db: Session, workspace_id: str) -> dict:
    """Walk a workspace's chain in order: every entry's hash recomputes, and links to the one before."""
    prev, n = None, 0
    for r in db.scalars(select(PluginAudit).where(PluginAudit.workspace_id == workspace_id, PluginAudit.entry_hash.is_not(None)).order_by(PluginAudit.id)):
        n += 1
        if r.prev_hash != prev:
            return {"ok": False, "checked": n, "brokenAt": r.id, "reason": "an entry before this one was removed or reordered"}
        if entry_hash(r) != r.entry_hash:
            return {"ok": False, "checked": n, "brokenAt": r.id, "reason": "this entry was changed after it was written"}
        prev = r.entry_hash
    return {"ok": True, "checked": n, "head": prev}


def entries(db: Session, ctx: RequestContext, limit: int = 200, action: str | None = None) -> list[dict]:
    q = select(PluginAudit).where(PluginAudit.workspace_id == ctx.workspace_id)
    if action:
        q = q.where(PluginAudit.action == action)
    rows = db.scalars(q.order_by(PluginAudit.id.desc()).limit(limit)).all()
    return [
        {"id": r.id, "actor": r.actor_id, "action": r.action, "target": r.target, "before": r.before_ref, "after": r.after_ref, "correlationId": r.correlation_id, "at": r.timestamp.isoformat()}
        for r in rows
    ]
