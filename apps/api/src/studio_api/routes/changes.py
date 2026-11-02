"""todo17 D7: change requests.

    GET  /api/v1/projects/{pid}/changes?state=open|all     {changes: [CR]}
    POST /api/v1/projects/{pid}/changes                    {title, operations:[{op, input}]} → CR (201)
    GET  /api/v1/projects/{pid}/changes/{cid}              CR + {diff:[{op, path, before, after}], findings}
    POST /api/v1/projects/{pid}/changes/{cid}/operations   {operations:[...]} → CR
    POST /api/v1/projects/{pid}/changes/{cid}/merge        → CR (403 for agents; 409 failing / needs-update)
    POST /api/v1/projects/{pid}/changes/{cid}/close        → CR
    POST /api/v1/projects/{pid}/changes/{cid}/comments     {body} → comment (201)

Opening and adding operations needs write access to the project. Agents open, append to and close
their own change requests; merging is a person's (or auto-merge's, `kernel/change_requests.py`).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import change_requests as crs
from ..kernel import projects
from ..kernel.admission.http import declares

router = APIRouter(prefix="/api/v1")
BASE = "/projects/{project_id}/changes"


@router.get(BASE)
def list_changes(project_id: str, state: str = "open", ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id)
    return {"changes": [crs.to_json(db, c) for c in crs.listing(db, p, state)]}


@router.post(BASE, status_code=201, openapi_extra=declares("change.open"))
def open_change(project_id: str, body: dict[str, Any] = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id, write=True)
    title = body.get("title") if isinstance(body.get("title"), str) else None
    return crs.to_json(db, crs.create(db, ctx, p, body.get("operations"), title=title))


@router.get(BASE + "/{cid}")
def get_change(project_id: str, cid: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id)
    return crs.to_json(db, crs.require(db, p, cid), detail=True)


@router.post(BASE + "/{cid}/operations", openapi_extra=declares("change.append"))
def add_operations(project_id: str, cid: str, body: dict[str, Any] = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id, write=True)
    return crs.to_json(db, crs.append(db, ctx, crs.require(db, p, cid), body.get("operations")))


@router.post(BASE + "/{cid}/merge", openapi_extra=declares("change.merge"))
def merge_change(project_id: str, cid: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id, write=True)
    cr = crs.merge(db, ctx, crs.require(db, p, cid))
    out = crs.to_json(db, cr, detail=True)
    if cr.state != "merged":
        # Committed (not raised), so the change request keeps its new state and findings.
        msg = "needs update: the project changed and the checks now fail" if cr.state == "needs-update" else "checks fail; update the change request first"
        return JSONResponse({"error": msg, "code": cr.state, "changeRequest": out}, status_code=409)
    return out


@router.post(BASE + "/{cid}/close", openapi_extra=declares("change.close"))
def close_change(project_id: str, cid: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id, write=True)
    return crs.to_json(db, crs.close(db, ctx, crs.require(db, p, cid)))


@router.post(BASE + "/{cid}/comments", status_code=201, openapi_extra=declares("change.comment"))
def comment_change(project_id: str, cid: str, body: dict[str, Any] = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id)
    return crs.comment_json(crs.comment(db, ctx, crs.require(db, p, cid), body.get("body")))
