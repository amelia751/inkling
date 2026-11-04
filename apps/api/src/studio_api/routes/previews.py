"""Preview Studios (todo23 D8, W6). Only the requester sees a preview.

    POST /api/v1/projects/{id}/previews                 {environment | preset, datasetId?, title?, pluginVersions?, verification?, ttlHours?}
                                                        → 201 the preview (its Studio is `taskId`, state `preview`)
    GET  /api/v1/projects/{id}/previews                 → {previews: [...]} the caller's active previews
    GET  /api/v1/projects/{id}/previews/{pid}           → one preview (410 once expired)
    POST /api/v1/projects/{id}/previews/{pid}/keep      → {preview, task}: the Studio moves to the workspace tier
    POST /api/v1/projects/{id}/previews/{pid}/discard   → 204: the preview, its Studio and its annotations are deleted
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import previews, projects

router = APIRouter(prefix="/api/v1")


def _caller(ctx: RequestContext) -> None:
    if ctx.principal.startswith(("plugin:", "worker:", "event:")):
        raise HTTPException(403, "only a person or their assistant works with previews")
    if not projects.person(ctx).startswith("user:"):
        raise HTTPException(403, "a preview is made for a person")


@router.post("/projects/{project_id}/previews", status_code=201)
def create_preview(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _caller(ctx)
    p = projects.require_project(db, ctx, project_id, write=True)
    return previews.preview_dict(previews.create(db, ctx, p, body))


@router.get("/projects/{project_id}/previews")
def list_previews(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _caller(ctx)
    p = projects.require_project(db, ctx, project_id)
    return {"previews": [previews.preview_dict(r) for r in previews.list_for(db, ctx, p)]}


@router.get("/projects/{project_id}/previews/{preview_id}")
def get_preview(project_id: str, preview_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _caller(ctx)
    p = projects.require_project(db, ctx, project_id)
    return previews.preview_dict(previews.require(db, ctx, p, preview_id))


@router.post("/projects/{project_id}/previews/{preview_id}/keep")
def keep_preview(project_id: str, preview_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _caller(ctx)
    p = projects.require_project(db, ctx, project_id, write=True)
    row, t = previews.keep(db, ctx, p, preview_id)
    return {"preview": previews.preview_dict(row), "task": projects.task_dict(db, t)}


@router.post("/projects/{project_id}/previews/{preview_id}/discard", status_code=204)
def discard_preview(project_id: str, preview_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _caller(ctx)
    p = projects.require_project(db, ctx, project_id)
    previews.discard(db, ctx, p, preview_id)
    return Response(status_code=204)
