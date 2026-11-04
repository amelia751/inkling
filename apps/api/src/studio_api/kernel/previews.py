"""Preview Studios (todo23 D8, W6): a generated Studio boots as a preview, then is kept or discarded.

- A preview is an `environment_previews` row plus a Studio (`tasks` row in state `preview`) whose
  environment revision 1 is the preview's immutable environment. Only the requester sees either.
- Annotations made in a preview are keyed by its Studio's task id, so they never touch another
  Studio's annotations, and discard deletes them with every other row keyed by that task id.
- Keep publishes the Studio to the workspace tier through the same state change a person's
  publish of a boot draft makes (`draft|preview` -> `published`), after `review_gate`.
- An expired preview is treated as discarded: it is purged the next time anything reads it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..db import Base
from ..models import DatasetRow, EnvironmentPreview, ProjectRow, TaskRow, WorkspaceEnvironment, WorkspacePlugin
from . import audit, projects

PREVIEW_STATE = "preview"
DEFAULT_TTL = timedelta(hours=24)
MAX_TTL = timedelta(days=7)
# Append-only logs keep their record that the preview existed; drops point at a Studio but are not its data.
_KEEP_TABLES = {"environment_previews", "plugin_audit", "audit_events", "drops"}


def _now() -> datetime:
    return datetime.now(UTC)


def _aware(d: datetime) -> datetime:
    return d if d.tzinfo else d.replace(tzinfo=UTC)


def expired(p: EnvironmentPreview) -> bool:
    return p.status == "active" and _aware(p.expires_at) <= _now()


def preview_dict(p: EnvironmentPreview, *, status: str | None = None) -> dict[str, Any]:
    return {
        "id": p.id,
        "projectId": p.project_id,
        "taskId": p.task_id,
        "environment": p.environment,
        "pluginVersions": p.plugin_versions or {},
        "requestedBy": p.requested_by,
        "status": status or p.status,
        "verification": p.verification,
        "expiresAt": projects.iso(p.expires_at),
        "createdAt": projects.iso(p.created_at),
        "keptAt": projects.iso(p.kept_at),
    }


def for_task(db: Session, task_id: str) -> EnvironmentPreview | None:
    return db.scalars(select(EnvironmentPreview).where(EnvironmentPreview.task_id == task_id)).first()


def guard_task(db: Session, ctx: RequestContext, t: TaskRow | None) -> None:
    """A preview's Studio is visible only to its requester (404 for anyone else, as if absent)."""
    if t is None or t.state != PREVIEW_STATE:
        return
    p = for_task(db, t.id)
    if p is None or p.requested_by != projects.person(ctx) or expired(p):
        raise HTTPException(404, "no such task")


def review_gate(db: Session, preview: EnvironmentPreview) -> tuple[bool, str | None]:
    """Whether a preview may be kept. TODO(todo23 W9): read the reviewer agent's review rows for
    this preview and refuse Keep while a required review is missing or failed. Always ok for now."""
    return True, None


def _pins(db: Session, project_id: str, given: Any) -> dict[str, str]:
    if isinstance(given, dict) and given:
        return {str(k): str(v) for k, v in given.items()}
    rows = db.scalars(select(WorkspacePlugin).where(WorkspacePlugin.workspace_id == project_id))
    return {r.plugin_id: r.version for r in rows if r.state in ("active", "installed")}


def _dataset(db: Session, p: ProjectRow, dataset_id: str | None) -> DatasetRow:
    if dataset_id:
        d = db.get(DatasetRow, str(dataset_id))
        if d is None or d.project_id != p.id:
            raise HTTPException(404, "no such dataset")
        return d
    if p.default_task_id:
        t = db.get(TaskRow, p.default_task_id)
        if t is not None and (d := db.get(DatasetRow, t.dataset_id)) is not None:
            return d
    d = db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id).order_by(DatasetRow.created_at.desc())).first()
    if d is None:
        raise HTTPException(422, "this project has no data to preview a Studio on; pass datasetId")
    return d


def create(db: Session, ctx: RequestContext, p: ProjectRow, body: dict) -> EnvironmentPreview:
    env = body.get("environment") or ({"extends": body["preset"]} if body.get("preset") else None)
    if not isinstance(env, dict) or not env:
        raise HTTPException(422, "a preview needs an `environment` (object) or a `preset`")
    try:
        hours = float(body["ttlHours"]) if body.get("ttlHours") is not None else None
    except (TypeError, ValueError):
        raise HTTPException(422, "ttlHours must be a number") from None
    ttl = min(timedelta(hours=hours), MAX_TTL) if hours and hours > 0 else DEFAULT_TTL
    d = _dataset(db, p, body.get("datasetId"))
    title = str(body.get("title") or "Preview").strip()[:256] or "Preview"
    t = projects.create_task(db, ctx, d, title, str(body.get("kind") or "annotate"), dict(env))
    t.state = PREVIEW_STATE
    t.booted_by = ctx.principal
    at = _now()
    row = EnvironmentPreview(
        id=projects.new_id("pvw"), project_id=p.id, task_id=t.id, environment=dict(env), plugin_versions=_pins(db, p.id, body.get("pluginVersions")),
        requested_by=projects.person(ctx), status="active", verification=body.get("verification") if isinstance(body.get("verification"), dict) else None,
        expires_at=at + ttl, created_at=at,
    )
    db.add(row)
    db.flush()
    audit.record(db, ctx.for_scope(p.id, t.id), "preview.created", target=row.id, after={"taskId": t.id, "pluginVersions": row.plugin_versions})
    return row


def _purge(db: Session, row: EnvironmentPreview) -> None:
    """Delete the preview, its Studio and every row keyed by the Studio's task id."""
    tid = row.task_id
    for table in Base.metadata.sorted_tables:
        if table.name in _KEEP_TABLES or "task_id" not in table.c:
            continue
        db.execute(delete(table).where(table.c.task_id == tid))
    db.execute(delete(TaskRow).where(TaskRow.id == tid))
    db.delete(row)
    db.flush()


def sweep(db: Session, project_id: str) -> None:
    """Expired previews are discarded."""
    rows = db.scalars(select(EnvironmentPreview).where(EnvironmentPreview.project_id == project_id, EnvironmentPreview.status == "active")).all()
    for r in rows:
        if expired(r):
            _purge(db, r)


def list_for(db: Session, ctx: RequestContext, p: ProjectRow) -> list[EnvironmentPreview]:
    sweep(db, p.id)
    q = select(EnvironmentPreview).where(EnvironmentPreview.project_id == p.id, EnvironmentPreview.requested_by == projects.person(ctx), EnvironmentPreview.status == "active")
    return list(db.scalars(q.order_by(EnvironmentPreview.created_at)))


def require(db: Session, ctx: RequestContext, p: ProjectRow, preview_id: str) -> EnvironmentPreview:
    row = db.get(EnvironmentPreview, preview_id)
    if row is None or row.project_id != p.id or row.requested_by != projects.person(ctx):
        raise HTTPException(404, "no such preview")
    if expired(row):
        _purge(db, row)
        raise HTTPException(410, "this preview expired and was discarded")
    return row


def keep(db: Session, ctx: RequestContext, p: ProjectRow, preview_id: str) -> tuple[EnvironmentPreview, TaskRow]:
    if ctx.principal.startswith("agent:"):
        raise HTTPException(403, "only the person who asked for a preview keeps it")
    row = require(db, ctx, p, preview_id)
    t = db.get(TaskRow, row.task_id)
    if row.status == "kept" and t is not None:
        return row, t
    if t is None:
        raise HTTPException(409, "this preview's Studio is gone")
    ok, reason = review_gate(db, row)
    if not ok:
        raise HTTPException(409, {"code": "review_required", "message": reason or "this preview needs a review before it is kept"})
    env = db.get(WorkspaceEnvironment, (p.id, t.id))
    if env is not None and env.environment != row.environment:
        raise HTTPException(409, "the preview's environment changed; previews are immutable")
    at = _now()
    t.state, t.published_by, t.published_at = "published", ctx.principal, at
    row.status, row.kept_at = "kept", at
    audit.record(db, ctx.for_scope(p.id, t.id), "preview.kept", target=row.id, after={"taskId": t.id})
    db.flush()
    return row, t


def discard(db: Session, ctx: RequestContext, p: ProjectRow, preview_id: str) -> None:
    row = db.get(EnvironmentPreview, preview_id)
    if row is None or row.project_id != p.id or row.requested_by != projects.person(ctx):
        raise HTTPException(404, "no such preview")
    if row.status == "kept":
        raise HTTPException(409, "this preview was kept; move its Studio to Trash instead")
    audit.record(db, ctx.for_scope(p.id, None), "preview.discarded", target=row.id, after={"taskId": row.task_id})
    _purge(db, row)
