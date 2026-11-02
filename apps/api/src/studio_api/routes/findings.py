"""todo17 D5, D9, D10: findings, fixes, promotion, scans, the gardener and the project context.

    GET  /api/v1/projects/{pid}/findings?state=open|all   { findings, counts, wouldHaveRejected }
    POST /api/v1/projects/{pid}/findings/{fid}/fix         { applied: true } (people) | { changeRequest } (agents)
    POST /api/v1/projects/{pid}/rules/promote              { rule, severity } → the rules (a rules edit)
    POST /api/v1/projects/{pid}/scan                       { jobId, state, result }
    POST /api/v1/projects/{pid}/gardener                   { changeRequest, fixes, skipped } (never merges)
    GET  /api/v1/projects/{pid}/context                    rules, findings by rule, what's published, …
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import findings, projects
from ..kernel import rules as krules

router = APIRouter(prefix="/api/v1")


@router.get("/projects/{project_id}/findings")
def list_findings(project_id: str, state: str = "open", limit: int = 500, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id)
    return findings.listing(db, p, krules.get(db, p)["rules"], state=state, limit=limit)


@router.post("/projects/{project_id}/findings/{finding_id}/fix")
def fix_finding(project_id: str, finding_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return findings.fix(db, ctx, projects.require_project(db, ctx, project_id, write=True), finding_id)


@router.post("/projects/{project_id}/rules/promote")
def promote_rule(project_id: str, body: dict[str, Any] = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    krules.require_person(ctx)
    return findings.promote(db, ctx, projects.require_project(db, ctx, project_id, write=True), body)


@router.post("/projects/{project_id}/scan")
def scan(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id)
    job_id = findings.enqueue_scan(db, p.id, "requested")
    out = findings.run_scan_job(db, job_id) or {}
    return {"jobId": job_id, "state": out.get("state", "queued"), "result": out.get("result")}


@router.post("/projects/{project_id}/gardener")
def gardener(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return findings.gardener(db, ctx, projects.require_project(db, ctx, project_id, write=True))


@router.get("/projects/{project_id}/context")
def project_context(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    projects.ensure_seeds_once(db)
    return findings.context(db, projects.require_project(db, ctx, project_id))
