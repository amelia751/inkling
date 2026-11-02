"""todo17 D3: a project's rules.

    GET   /api/v1/projects/{pid}/rules            { rules, revision, source: project|preset|default, preset }
    PUT   /api/v1/projects/{pid}/rules            { rules, baseRevision } → the saved rules (409 if stale)
    PATCH /api/v1/projects/{pid}/rules            { ops: JSON Patch, baseRevision } → the same
    (both `rules.update`: `?dryRun=true` checks without saving; removing a label annotations still
    use is 422 `label.in-use`, whose fix is `labels.merge`, see routes/labels.py)
    GET   /api/v1/projects/{pid}/rules/history    { history: [{ revision, rules, actor, onBehalfOf, createdAt }] }

Members read; editors (people only) write. Agent and delegated tokens are refused writes (403).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import label_ops, projects, rules
from ..kernel.admission.http import WriteParams, declares, write_params

router = APIRouter(prefix="/api/v1")


@router.get("/projects/{project_id}/rules")
def get_rules(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return rules.get(db, projects.require_project(db, ctx, project_id))


@router.put("/projects/{project_id}/rules", openapi_extra=declares(label_ops.RULES_UPDATE))
def put_rules(project_id: str, body: dict[str, Any] = Body(...), w: WriteParams = Depends(write_params), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    rules.require_person(ctx)
    p = projects.require_project(db, ctx, project_id, write=True)
    label_ops.admit_rules_update(ctx, p, dry_run=w.dry_run)
    return rules.put(db, ctx, p, body, dry_run=w.dry_run)


@router.patch("/projects/{project_id}/rules", openapi_extra=declares(label_ops.RULES_UPDATE))
def patch_rules(project_id: str, body: dict[str, Any] = Body(...), w: WriteParams = Depends(write_params), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    rules.require_person(ctx)
    p = projects.require_project(db, ctx, project_id, write=True)
    label_ops.admit_rules_update(ctx, p, dry_run=w.dry_run)
    return rules.patch(db, ctx, p, body, dry_run=w.dry_run)


@router.get("/projects/{project_id}/rules/history")
def rules_history(project_id: str, limit: int = 50, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return rules.history(db, projects.require_project(db, ctx, project_id), limit)
