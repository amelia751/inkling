"""Event API (docs/plugins.md §6): typed outbox with at-least-once delivery.

`publish` writes to the outbox in the caller's transaction. `deliver` turns each pending
event into one job per subscribed active plugin (`events.subscribes` in its manifest).
Guards: a per-workspace rate limit, a depth limit so event → job → event chains stop
(recursion / loop detection, §10), and idempotency keys so a redelivery is a no-op.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext
from ..models import PluginEvent

EVENT_TYPES = {"asset.ingested", "annotations.committed", "job.succeeded", "job.failed", "plugin.activated", "plugin.disabled"}


def publish(db: Session, ctx: RequestContext, type_: str, payload: dict, *, source: str, depth: int = 0, idempotency_key: str | None = None) -> PluginEvent | None:
    if type_ not in EVENT_TYPES:
        raise HTTPException(422, f"unknown event type {type_!r}")
    if depth > settings().event_max_depth:
        raise HTTPException(429, f"event chain deeper than {settings().event_max_depth}: dropped {type_} (loop guard)")
    if idempotency_key and db.scalar(select(PluginEvent.event_id).where(PluginEvent.workspace_id == ctx.workspace_id, PluginEvent.idempotency_key == idempotency_key)):
        return None
    since = datetime.now(UTC) - timedelta(minutes=1)
    recent = db.scalar(select(func.count()).select_from(PluginEvent).where(PluginEvent.workspace_id == ctx.workspace_id, PluginEvent.created_at >= since))
    if (recent or 0) >= settings().event_rate_per_minute:
        raise HTTPException(429, "event rate limit reached for this workspace")
    ev = PluginEvent(workspace_id=ctx.workspace_id, type=type_, payload=payload, source=source, correlation_id=ctx.correlation_id, depth=depth, idempotency_key=idempotency_key)
    db.add(ev)
    db.flush()
    from . import eventbus

    eventbus.notify(db, ev)
    return ev


def deliver(db: Session, limit: int = 100, older_than_s: float | None = None) -> int:
    """Fan pending events out to subscribed active plugins as jobs. Returns how many were delivered.

    Rows are locked with SKIP LOCKED on Postgres, so replicas delivering at once split the
    outbox instead of fanning one event out twice."""
    q = select(PluginEvent).where(PluginEvent.delivered.is_(False))
    if older_than_s is not None:
        q = q.where(PluginEvent.created_at < datetime.now(UTC) - timedelta(seconds=older_than_s))
    q = q.order_by(PluginEvent.created_at).limit(limit)
    if db.get_bind().dialect.name == "postgresql":
        q = q.with_for_update(skip_locked=True)
    n = 0
    for ev in db.scalars(q).all():
        fan_out(db, ev)
        n += 1
    return n


def fan_out(db: Session, ev: PluginEvent) -> None:
    """One job per active plugin subscribed to the event's type; marks the event delivered."""
    from ..context import RequestContext as Ctx
    from ..plugins import installer

    from . import jobs

    ev.attempts += 1
    for inst, manifest in installer.active_manifests(db, ev.workspace_id):
        if ev.type not in ((manifest.get("events") or {}).get("subscribes") or []):
            continue
        if inst.plugin_id == ev.source:
            continue  # a plugin's own events never trigger it again
        run_ctx = Ctx(ev.workspace_id, f"event:{ev.type}", ev.correlation_id, idempotency_key=f"event:{ev.event_id}:{inst.plugin_id}")
        jobs.enqueue(db, run_ctx, plugin_id=inst.plugin_id, version=inst.version, tool="on_event", input={"event": {"id": ev.event_id, "type": ev.type, "payload": ev.payload, "depth": ev.depth + 1}}, capability=None, provider=None, estimated_cost_usd=0.0, timeout_s=60)
    ev.delivered = True
