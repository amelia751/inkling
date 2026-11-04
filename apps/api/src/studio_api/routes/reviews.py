"""Artifact reviews (todo23 W9, D11).

    POST /api/v1/projects/{id}/reviews                a review.v1 document (reviewer sessions, people)
    GET  /api/v1/projects/{id}/reviews?artifact=kind:id@version
    POST /api/v1/projects/{id}/reviews/hidden-tests   {artifact, path, content} (reviewer sessions only)
    GET  /api/v1/projects/{id}/reviews/hidden-tests?artifact=…   (never builder sessions)
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import audit, projects, reviews

router = APIRouter(prefix="/api/v1")


@router.post("/projects/{project_id}/reviews", status_code=201)
def submit_review(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.require_project(db, ctx, project_id)
    row = reviews.submit(db, ctx, dict(body))
    audit.record(db, ctx, "reviews.submit", target=f"{row.artifact_kind}:{row.artifact_id}@{row.artifact_version}", after={"id": row.id, "verdict": row.verdict})
    return reviews.review_dict(row)


@router.get("/projects/{project_id}/reviews")
def get_reviews(project_id: str, artifact: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.require_project(db, ctx, project_id)
    ref = reviews.parse_artifact(artifact) if artifact else None
    rows = reviews.list_reviews(db, ctx.workspace_id, ref)
    out: dict = {"reviews": [reviews.review_dict(r) for r in rows]}
    if ref is not None:
        out["passing"] = bool(rows) and rows[0].verdict == "pass"
    return out


@router.post("/projects/{project_id}/reviews/hidden-tests", status_code=201)
def add_hidden_test(project_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.require_project(db, ctx, project_id)
    row = reviews.add_hidden_test(db, ctx, dict(body))
    audit.record(db, ctx, "reviews.hidden_test", target=f"{row.artifact_kind}:{row.artifact_id}@{row.artifact_version}", after={"id": row.id, "path": row.path})
    return {"id": row.id, "path": f"hidden-tests/{row.artifact_kind}/{row.artifact_id}/{row.artifact_version}/{row.path}"}


@router.get("/projects/{project_id}/reviews/hidden-tests")
def list_hidden_tests(project_id: str, artifact: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.require_project(db, ctx, project_id)
    return {"tests": reviews.hidden_tests(db, ctx, reviews.parse_artifact(artifact))}
