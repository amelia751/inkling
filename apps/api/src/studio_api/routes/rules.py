"""todo17 D3: a project's rules.

    GET   /api/v1/projects/{pid}/rules            { rules, revision, source: project|preset|default, preset }
    PUT   /api/v1/projects/{pid}/rules            { rules, baseRevision } → the saved rules (409 if stale)
    PATCH /api/v1/projects/{pid}/rules            { ops: JSON Patch, baseRevision } → the same
    GET   /api/v1/projects/{pid}/rules/history    { history: [{ revision, rules, actor, onBehalfOf, createdAt }] }

Members read; editors (people) write. An agent's write (assistant, MCP/OAuth client, API key
without admin) becomes a change request instead (todo17 D7): 202 `{changeRequest}`; it may be
auto-merged at once when the checks pass and the project's `merge.auto` allows it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import admission, projects, rules
from ..kernel import change_requests as crs
from ..kernel.admission.http import declares

router = APIRouter(prefix="/api/v1")


@router.get("/projects/{project_id}/rules")
def get_rules(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return rules.get(db, projects.require_project(db, ctx, project_id))


def _as_change_request(db: Session, ctx: RequestContext, p, inp: dict[str, Any]) -> JSONResponse:
    """An agent's rules write: through `admit`, whose permit step opens (or appends to) the
    agent's change request instead of applying (rules are always published)."""
    res = admission.admit("rules.update", inp, crs.admission_ctx(db, ctx, p))
    return JSONResponse({**res.value, "findings": res.findings_json()}, status_code=202)


@router.put("/projects/{project_id}/rules", openapi_extra=declares("rules.update"))
def put_rules(project_id: str, body: dict[str, Any] = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id, write=True)
    if crs.is_agent(ctx):
        return _as_change_request(db, ctx, p, {"rules": body.get("rules")})
    return rules.put(db, ctx, p, body)


@router.patch("/projects/{project_id}/rules", openapi_extra=declares("rules.update"))
def patch_rules(project_id: str, body: dict[str, Any] = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id, write=True)
    if crs.is_agent(ctx):
        return _as_change_request(db, ctx, p, {"ops": body.get("ops")})
    return rules.patch(db, ctx, p, body)


@router.get("/projects/{project_id}/rules/history")
def rules_history(project_id: str, limit: int = 50, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return rules.history(db, projects.require_project(db, ctx, project_id), limit)
