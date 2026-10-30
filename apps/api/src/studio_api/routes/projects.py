"""Projects, datasets, tasks, resume, activity and live updates (todo6 Phase 1.2).

    GET/POST    /api/v1/projects                     list (with lastActivityAt + resume) / create
    GET/PATCH   /api/v1/projects/{id}
    GET         /api/v1/projects/{id}/overview       resume, data cards, attention (blocks omitted when empty)
    GET         /api/v1/projects/{id}/review         the whole review queue (Overview shows its top 5)
    GET/POST    /api/v1/projects/{id}/datasets
    GET         /api/v1/projects/{id}/datasets/{datasetId}         (not /v1/datasets/{id}: versioning has that)
    GET/POST    /api/v1/projects/{id}/datasets/{datasetId}/tasks
    GET         /api/v1/tasks/{id}                   one task
    GET         /api/v1/tasks/{id}/document          a Project-shaped document for the Studio
    GET/PUT     /api/v1/projects/{id}/resume
    GET         /api/v1/projects/{id}/activity
    GET         /api/v1/projects/{id}/events         SSE: import.updated, source.node.inspected, proposal.*

Membership comes from the request context (the principal, or the person an agent acts for),
never from a body.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session, session_scope
from ..kernel import events, overview, projects
from ..models import DatasetRow, PluginEvent, TaskRow

router = APIRouter(prefix="/api/v1")


@router.get("/projects")
def list_projects(q: str | None = None, sort: str = "recent", archived: bool = False, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"projects": projects.list_projects(db, ctx, q, sort, archived)}


@router.post("/projects", status_code=201)
def create_project(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.create_project(db, ctx, str(body.get("title") or ""), str(body.get("description") or ""), str(body.get("visibility") or "private"))
    return projects.project_dict(db, ctx, p)


@router.get("/projects/{project_id}")
def get_project(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return projects.project_dict(db, ctx, projects.require_project(db, ctx, project_id))


@router.patch("/projects/{project_id}")
def patch_project(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.scopes:
        raise HTTPException(403, "only people change a project's details")
    p = projects.require_project(db, ctx, project_id, write=True)
    return projects.project_dict(db, ctx, projects.patch_project(db, ctx, p, body))


@router.get("/projects/{project_id}/overview")
def project_overview(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return overview.overview(db, ctx, projects.require_project(db, ctx, project_id))


@router.get("/projects/{project_id}/review")
def project_review(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"items": overview.review_queue(db, projects.require_project(db, ctx, project_id))}


# ---- Datasets and tasks ------------------------------------------------------------------------


@router.get("/projects/{project_id}/datasets")
def list_datasets(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id)
    return {"datasets": [projects.dataset_dict(db, d) for d in db.scalars(select(DatasetRow).where(DatasetRow.project_id == p.id).order_by(DatasetRow.created_at))]}


@router.post("/projects/{project_id}/datasets", status_code=201)
def create_dataset(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The simple form (pick folders, pick a preset); the guided path is confirming a proposal."""
    if ctx.scopes:
        raise HTTPException(403, "only people create datasets; the assistant can propose one")
    p = projects.require_project(db, ctx, project_id, write=True)
    d = projects.create_dataset(db, ctx, p, str(body.get("title") or ""), {"nodeIds": body.get("nodeIds") or []}, str(body.get("description") or ""))
    task = body.get("task")
    if isinstance(task, dict):
        env = task.get("environment") or ({"extends": task["preset"]} if task.get("preset") else None)
        projects.create_task(db, ctx, d, str(task.get("title") or d.title), str(task.get("kind") or "annotate"), env)
    return projects.dataset_dict(db, d)


def _dataset(db: Session, ctx: RequestContext, project_id: str, dataset_id: str) -> DatasetRow:
    d, p = projects.require_dataset(db, ctx, dataset_id)
    if p.id != project_id:
        raise HTTPException(404, "no such dataset in this project")
    return d


@router.get("/projects/{project_id}/datasets/{dataset_id}")
def get_dataset(project_id: str, dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return projects.dataset_dict(db, _dataset(db, ctx, project_id, dataset_id))


@router.get("/projects/{project_id}/datasets/{dataset_id}/tasks")
def list_tasks(project_id: str, dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    d = _dataset(db, ctx, project_id, dataset_id)
    return {"tasks": [projects.task_dict(db, t) for t in db.scalars(select(TaskRow).where(TaskRow.dataset_id == d.id).order_by(TaskRow.created_at))]}


@router.post("/projects/{project_id}/datasets/{dataset_id}/tasks", status_code=201)
def create_task(project_id: str, dataset_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.scopes:
        raise HTTPException(403, "only people create tasks; the assistant can propose one")
    d = _dataset(db, ctx, project_id, dataset_id)
    projects.require_project(db, ctx, d.project_id, write=True)
    env = body.get("environment") or ({"extends": body["preset"]} if body.get("preset") else None)
    return projects.task_dict(db, projects.create_task(db, ctx, d, str(body.get("title") or ""), str(body.get("kind") or "annotate"), env))


@router.get("/tasks/{task_id}")
def get_task(task_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    t, _ = projects.require_task(db, ctx, task_id)
    return projects.task_dict(db, t)


@router.get("/tasks/{task_id}/document")
def task_document(task_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    t, _ = projects.require_task(db, ctx, task_id)
    return projects.task_document(db, t)


# ---- Resume and activity -----------------------------------------------------------------------


@router.get("/projects/{project_id}/resume")
def get_resume(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"resume": projects.get_resume(db, ctx, projects.require_project(db, ctx, project_id))}


@router.put("/projects/{project_id}/resume")
def put_resume(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"resume": projects.put_resume(db, ctx, projects.require_project(db, ctx, project_id), body)}


@router.get("/projects/{project_id}/activity")
def project_activity(project_id: str, cursor: int | None = None, limit: int = 100, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return overview.activity(db, projects.require_project(db, ctx, project_id), cursor, max(1, min(limit, 500)))


# ---- Live updates ------------------------------------------------------------------------------

SSE_POLL_S = 1.0
SSE_MAX_S = 300.0


@router.get("/projects/{project_id}/events")
async def project_events(project_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Server-sent events for a project. The stream reads the outbox (the same table every
    replica writes), so it works behind any replica and keeps nothing in process memory; the
    browser reconnects after `SSE_MAX_S` with `Last-Event-ID`, and invalidates its queries."""
    p = projects.require_project(db, ctx, project_id)
    last = request.headers.get("Last-Event-ID") or request.query_params.get("after")
    db.close()

    types = sorted(events.PROJECT_EVENTS - {"source.uploaded"})

    def newest() -> str | None:
        with session_scope() as s:
            return s.scalar(select(PluginEvent.event_id).where(PluginEvent.workspace_id == p.id).order_by(PluginEvent.created_at.desc()).limit(1))

    def after(cursor: str | None) -> list[tuple[str, str, dict]]:
        with session_scope() as s:
            q = select(PluginEvent).where(PluginEvent.workspace_id == p.id, PluginEvent.type.in_(types))
            cut = s.get(PluginEvent, cursor) if cursor else None
            if cut is not None:
                # `>=`: events in the same millisecond aren't lost; a repeat only re-invalidates.
                q = q.where(PluginEvent.created_at >= cut.created_at, PluginEvent.event_id != cut.event_id)
            return [(e.event_id, e.type, e.payload) for e in s.scalars(q.order_by(PluginEvent.created_at).limit(200))]

    async def stream():
        cursor = last or newest()
        yield "retry: 3000\n\n"
        waited = 0.0
        while waited < SSE_MAX_S and not await request.is_disconnected():
            for eid, kind, payload in after(cursor):
                cursor = eid
                yield f"id: {eid}\nevent: {kind}\ndata: {json.dumps(payload)}\n\n"
            await asyncio.sleep(SSE_POLL_S)
            waited += SSE_POLL_S
            yield ": keep-alive\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
