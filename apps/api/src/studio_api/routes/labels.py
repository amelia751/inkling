"""todo17 Milestone 1: label rename and merge, as operations (kernel/label_ops.py).

    POST /api/v1/projects/{pid}/labels/rename           { from, to, baseRevision? }
    POST /api/v1/projects/{pid}/labels/merge            { from: [...], into, baseRevision? }
        -> { rules, revision, ..., rewritten: { annotations, documents }, historyId, findings }
    POST /api/v1/projects/{pid}/labels/undo/{historyId} -> { rules, revision, ..., restored, skipped }

All take `?dryRun=true` (counts, nothing saved) and `Idempotency-Key`. People only (agents propose
label changes as a change request); editors of the project.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import engine, get_session
from ..kernel import label_ops, projects, rules
from ..kernel.admission.http import WriteParams, declares, write_params
from ..kernel.admission.idempotency import SqlIdempotencyStore, run_idempotent

router = APIRouter(prefix="/api/v1")


def _run(op_id: str, project_id: str, body: Any, w: WriteParams, ctx: RequestContext, db: Session, fn) -> JSONResponse:  # noqa: ANN001
    rules.require_person(ctx)
    p = projects.require_project(db, ctx, project_id, write=True)
    status, out = run_idempotent(
        None if w.dry_run else SqlIdempotencyStore(engine()),
        w.idempotency_key,
        ctx.principal,
        op_id,
        {"project": project_id, "body": body},
        lambda: (200, fn(p)),
    )
    return JSONResponse(out, status_code=status)


@router.post("/projects/{project_id}/labels/rename", openapi_extra=declares(label_ops.RENAME))
def rename_label(project_id: str, body: dict[str, Any] = Body(...), w: WriteParams = Depends(write_params), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(label_ops.RENAME, project_id, body, w, ctx, db, lambda p: label_ops.apply(db, ctx, p, label_ops.RENAME, body, dry_run=w.dry_run))


@router.post("/projects/{project_id}/labels/merge", openapi_extra=declares(label_ops.MERGE))
def merge_labels(project_id: str, body: dict[str, Any] = Body(...), w: WriteParams = Depends(write_params), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(label_ops.MERGE, project_id, body, w, ctx, db, lambda p: label_ops.apply(db, ctx, p, label_ops.MERGE, body, dry_run=w.dry_run))


@router.post("/projects/{project_id}/labels/undo/{history_id}", openapi_extra=declares(label_ops.UNDO))
def undo_label_op(project_id: str, history_id: int, w: WriteParams = Depends(write_params), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return _run(label_ops.UNDO, project_id, {"historyId": history_id}, w, ctx, db, lambda p: label_ops.undo(db, ctx, p, history_id, dry_run=w.dry_run))
