"""Server-side Studio boots (todo11 D1, §6 contracts).

    POST /api/v1/projects/{id}/boots   {bootId, preset, patch?, files?, folders?, name?, intent?}
                                       → 202 {bootId, taskIds, state, …}; 403 outside the agent
                                         scope, 409 bootId reused, 422 validation (environment
                                         PATCH's error shape)
    GET  /api/v1/boots/{bootId}        → the boot and its steps
    POST /api/v1/tasks/{taskId}/publish → a person publishes a draft (agents: 403)

Progress is on the project event stream: `boot.started`, `boot.step`, `boot.ready|failed`,
and `environment.updated` for each revision written.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session, session_scope
from ..kernel import boots, projects
from ..models import Boot

router = APIRouter(prefix="/api/v1")
log = logging.getLogger(__name__)


@router.post("/projects/{project_id}/boots", status_code=202)
def create_boot(project_id: str, request: Request, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.principal.startswith(("plugin:", "worker:", "event:")):
        raise HTTPException(403, "only a person or their assistant boots a Studio")
    if boots.is_agent(ctx) and not ctx.on_behalf_of:
        raise HTTPException(403, "an agent boots a Studio only on behalf of a person")
    p = projects.require_project(db, ctx, project_id, write=True)
    try:
        status, out = boots.boot(db, ctx, p, body, request.headers)
    except Exception as e:  # after validation: record the failure, then answer
        db.rollback()
        status = e.status_code if isinstance(e, HTTPException) else 500
        message = str(e.detail) if isinstance(e, HTTPException) else "the boot failed; nothing was created"
        with session_scope() as s:
            failed = boots.record_failure(s, ctx, p.id, body, "task", message)
        if status == 500:
            log.exception("boot %s failed", body.get("bootId"))
        return JSONResponse({"error": message, **({"boot": failed} if failed else {})}, status_code=status)
    if status != 202:
        db.rollback()
    return JSONResponse(out, status_code=status)


@router.get("/boots/{boot_id}")
def get_boot(boot_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    b = db.get(Boot, boot_id)
    if b is None:
        raise HTTPException(404, "no such boot")
    projects.require_project(db, ctx, b.project_id)
    return boots.boot_doc(b)


@router.post("/tasks/{task_id}/publish")
def publish_task(task_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return projects.task_dict(db, boots.publish(db, ctx, task_id))
