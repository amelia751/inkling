"""Event API (docs/plugins.md §6): typed outbox with at-least-once delivery.

`publish` writes to the outbox in the caller's transaction. `deliver` turns each pending
event into one job per subscribed active plugin (`events.subscribes` in its manifest).
Guards: a per-workspace rate limit, a depth limit so event → job → event chains stop
(recursion / loop detection, §10), and idempotency keys so a redelivery is a no-op.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import and_, func, literal_column, or_, select, text
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext
from ..models import PluginEvent

EVENT_TYPES = {
    "asset.ingested",
    "annotations.committed",
    "job.succeeded",
    "job.failed",
    "plugin.activated",
    "plugin.disabled",
    # Dataset versioning (todo4 Phase 6): published by the kernel when it opens a review, and
    # again whenever a head move sends a review back to CHECKING, so worker-side checks
    # (de-identification) run for the review's current (source, target) oids.
    "versioning.review.opened",
    "versioning.review.checks_requested",
    # Projects and sources (todo6): `source.uploaded` starts inspection in the worker; the
    # rest feed a project's live updates (GET /v1/projects/:id/events).
    "source.uploaded",
    "import.updated",
    "source.node.inspected",
    "proposal.created",
    "proposal.decided",
    # Files (todo7): a namespace batch changed these folders' children.
    "fs.changed",
    # Live boot (todo11 §6 contracts): every environment write, and a boot's progress.
    "environment.updated",
    "boot.started",
    "boot.step",
    "boot.ready",
    "boot.failed",
    # Item lifecycle (todo11 D8): files dropped into a Studio, as they register, upload and
    # the worker makes their derivatives (kernel/ingest.py).
    "item.registered",
    "item.uploaded",
    "item.probed",
    "item.thumb_ready",
    "item.preview_ready",
    "item.ready",
    "item.failed",
    # Pipelines (todo12 §4 M1, docs/pipeline.md §15): published by `service:pipeline` through
    # POST /api/v1/service/events, source "pipeline", idempotency key `<run_id>/<event>[/<step_id>]`.
    *(PIPELINE_EVENTS := (
        "pipeline.run.started",
        "pipeline.run.completed",
        "pipeline.run.failed",
        "pipeline.run.paused",
        "pipeline.step.started",
        "pipeline.step.completed",
        "pipeline.step.failed",
        "pipeline.output.staged",
        "dataset.candidate.created",
        "review.requested",
        "review.approved",
    )),
}

# Project updates (the project SSE stream, GET /v1/projects/:id/events, carries these; the
# pipeline's are all project-scoped: a run belongs to one project): never rate limited (an import of 10k files is one
# session, but its progress events must not starve plugin events or each other).
PROJECT_EVENTS = {"source.uploaded", "import.updated", "source.node.inspected", "proposal.created", "proposal.decided", "fs.changed", "environment.updated", "boot.started", "boot.step", "boot.ready", "boot.failed", "item.registered", "item.uploaded", "item.probed", "item.thumb_ready", "item.preview_ready", "item.ready", "item.failed", *PIPELINE_EVENTS}


# Published by the kernel itself when a job ends: never rate limited either, or a busy
# workspace's job outcomes could be dropped and a waiting pipeline step never told.
KERNEL_EVENTS = {"job.succeeded", "job.failed"}


def claim_for(db: Session, subscriber: str, types: list[str], limit: int = 20) -> list[PluginEvent]:
    """Events of `types` that built-in `subscriber` hasn't acknowledged yet (oldest first)."""
    from ..models import EventConsumption

    done = select(EventConsumption.event_id).where(EventConsumption.subscriber == subscriber)
    return list(db.scalars(select(PluginEvent).where(PluginEvent.type.in_(types), PluginEvent.event_id.not_in(done)).order_by(PluginEvent.created_at).limit(limit)))


def ack(db: Session, subscriber: str, event_ids: list[str]) -> int:
    from ..models import EventConsumption

    n = 0
    for eid in event_ids:
        if db.get(EventConsumption, (subscriber, eid)) is None and db.get(PluginEvent, eid) is not None:
            db.add(EventConsumption(subscriber=subscriber, event_id=eid))
            n += 1
    db.flush()
    return n


def publish(db: Session, ctx: RequestContext, type_: str, payload: dict, *, source: str, depth: int = 0, idempotency_key: str | None = None, payload_ref: str | None = None) -> PluginEvent | None:
    if type_ not in EVENT_TYPES:
        raise HTTPException(422, f"unknown event type {type_!r}")
    if depth > settings().event_max_depth:
        raise HTTPException(429, f"event chain deeper than {settings().event_max_depth}: dropped {type_} (loop guard)")
    if idempotency_key and db.scalar(select(PluginEvent.event_id).where(PluginEvent.workspace_id == ctx.workspace_id, PluginEvent.idempotency_key == idempotency_key)):
        return None
    since = datetime.now(UTC) - timedelta(minutes=1)
    recent = db.scalar(select(func.count()).select_from(PluginEvent).where(PluginEvent.workspace_id == ctx.workspace_id, PluginEvent.created_at >= since))
    if (recent or 0) >= settings().event_rate_per_minute and type_ not in PROJECT_EVENTS and type_ not in KERNEL_EVENTS:
        raise HTTPException(429, "event rate limit reached for this workspace")
    ev = PluginEvent(workspace_id=ctx.workspace_id, type=type_, payload=payload, payload_ref=payload_ref, source=source, correlation_id=ctx.correlation_id, depth=depth, idempotency_key=idempotency_key)
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


# ---- The service event feed (todo12 §4 M0 item 6, §5 contracts) ------------------------------
# Cross-workspace, for service principals only (routes/service.py). The cursor is opaque to
# callers. On Postgres every row carries its writing transaction's id (`feed_seq`); a read
# returns only rows below the oldest transaction still running (`pg_snapshot_xmin`), in
# (feed_seq, event_id) order, so an event whose transaction commits late is never behind a
# cursor that already moved past it. The cost: a long-running transaction anywhere in the
# database delays (never drops) the feed. SQLite (dev) has one writer, so rowid order is
# commit order. Polling, not LISTEN/NOTIFY: a notification still has to wait for xmin, and a
# LISTEN connection per waiting request doesn't survive a transaction pooler.

FEED_MAX = 500
_HIGH = "~"  # sorts after every event id (hex), so a "seen everything below xmin" cursor


def _parse_cursor(cursor: str | None, pg: bool) -> tuple[int, str]:
    if not cursor or cursor == "0":
        return (-1, "") if pg else (0, "")
    try:
        kind, rest = cursor.split(":", 1)
        if pg and kind == "x":
            seq, eid = rest.split(":", 1)
            return int(seq), eid
        if not pg and kind == "r":
            return int(rest), ""
    except ValueError:
        pass
    raise HTTPException(422, "bad cursor (it comes from a previous response, or 0 to start)")


def envelope(e: PluginEvent) -> dict:
    """The `plugin_events` columns (docs/pipeline.md §15)."""
    return {
        "event_id": e.event_id,
        "workspace_id": e.workspace_id,
        "type": e.type,
        "source": e.source,
        "correlation_id": e.correlation_id,
        "depth": e.depth,
        "idempotency_key": e.idempotency_key,
        "payload": e.payload,
        "payload_ref": e.payload_ref,
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }


def feed(db: Session, after: str | None, types: list[str] | None, limit: int = 100) -> tuple[list[dict], str]:
    """Events after `after` (oldest first) and the cursor to pass next time."""
    limit = max(1, min(FEED_MAX, limit))
    pg = db.get_bind().dialect.name == "postgresql"
    seq, eid = _parse_cursor(after, pg)
    if pg:
        # One snapshot for both statements: the horizon and the rows below it.
        db.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        xmin = int(db.scalar(text("SELECT pg_snapshot_xmin(pg_current_snapshot())::text::bigint")))
        q = select(PluginEvent).where(PluginEvent.feed_seq < xmin, or_(PluginEvent.feed_seq > seq, and_(PluginEvent.feed_seq == seq, PluginEvent.event_id > eid)))
        if types:
            q = q.where(PluginEvent.type.in_(types))
        rows = list(db.scalars(q.order_by(PluginEvent.feed_seq, PluginEvent.event_id).limit(limit)))
        if len(rows) == limit:
            return [envelope(e) for e in rows], f"x:{rows[-1].feed_seq}:{rows[-1].event_id}"
        # Nothing more below the horizon: start next time from it, past the rows we skipped.
        top = max(seq, xmin - 1)
        return [envelope(e) for e in rows], f"x:{top}:{_HIGH}" if top >= 0 else (after or "0")
    rowid = literal_column("plugin_events.rowid")
    q = select(PluginEvent, rowid).where(rowid > seq)
    if types:
        q = q.where(PluginEvent.type.in_(types))
    got = list(db.execute(q.order_by(rowid).limit(limit)))
    return [envelope(e) for e, _ in got], f"r:{got[-1][1] if got else seq}"
