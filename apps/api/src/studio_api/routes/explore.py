"""Proposals (todo6 Phase 1.2, 5.2): what the worker, the assistant or a person suggests.

    GET   /api/v1/projects/{id}/proposals?status=   proposed | confirmed | dismissed | superseded (comma list)
    POST  /api/v1/projects/{id}/proposals           create one (agents: `created_by` is agent:<run>)
    GET   /api/v1/proposals/{id}
    POST  /api/v1/proposals/{id}/confirm            optional edited payload; people only
    POST  /api/v1/proposals/{id}/dismiss            people only
    POST  /api/v1/proposals/{id}/recompute          a relationship with another column, target, ID rule or row
                                                    fixes; a mapping with another column or renamed classes;
                                                    a dataset with another name
    GET   /api/v1/proposals/{id}/preview            what confirming a dataset proposal will do (action preview)
    GET   /api/v1/projects/{id}/explore             Explore's Summary (files, records, tasks) and Quality list

Agents may create proposals but never confirm them (docs/ux.md §9): confirm and dismiss
answer 403 to any session token.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import explore, projects

router = APIRouter(prefix="/api/v1")

# The agent service names the run a proposal came from (todo6 Phase 6). It holds the session
# token anyway, so the header only adds detail to an `agent:` author; it can't make one up.
RUN_HEADER = "X-Agent-Run"
RUN_RE = re.compile(r"run_[A-Za-z0-9-]{1,64}")


def author(ctx: RequestContext, request: Request) -> str:
    run = request.headers.get(RUN_HEADER) or ""
    if ctx.scopes and ctx.principal.startswith("agent:") and RUN_RE.fullmatch(run):
        return f"agent:{run}"
    return ctx.principal


@router.get("/projects/{project_id}/proposals")
def list_proposals(project_id: str, status: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"proposals": projects.list_proposals(db, projects.require_project(db, ctx, project_id), status)}


@router.post("/projects/{project_id}/proposals", status_code=201)
def create_proposal(project_id: str, request: Request, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    p = projects.require_project(db, ctx, project_id, write=True)
    if ctx.scopes and not ctx.allows("proposals.write"):
        raise HTTPException(403, "this session can't propose changes")
    # The kernel names the author (`agent:<run>` or `user:…`) from the context, never the body.
    created_by = author(ctx, request)
    payload = body["payload"] if isinstance(body.get("payload"), dict) else {}
    evidence = body["evidence"] if isinstance(body.get("evidence"), dict) else {}
    kind = str(body.get("kind") or "")
    payload, evidence, strength = explore.from_agent(db, p, kind, payload, evidence)
    pr = projects.create_proposal(db, ctx, p, kind, payload, evidence, strength or str(body.get("strength") or "possible"), created_by)
    return projects.proposal_dict(pr)


@router.get("/proposals/{proposal_id}")
def get_proposal(proposal_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    pr, _ = projects.require_proposal(db, ctx, proposal_id)
    return projects.proposal_dict(pr)


@router.post("/proposals/{proposal_id}/confirm")
def confirm(proposal_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    pr, p = projects.require_proposal(db, ctx, proposal_id, write=True)
    return projects.decide(db, ctx, pr, p, "confirm", body.get("payload"))


@router.post("/proposals/{proposal_id}/dismiss")
def dismiss(proposal_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    pr, p = projects.require_proposal(db, ctx, proposal_id, write=True)
    return projects.decide(db, ctx, pr, p, "dismiss")


@router.post("/proposals/{proposal_id}/recompute")
def recompute(proposal_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    pr, p = projects.require_proposal(db, ctx, proposal_id)
    projects.require_project(db, ctx, p.id, write=True)
    return projects.proposal_dict(explore.recompute(db, ctx, p, pr, body))


@router.get("/proposals/{proposal_id}/preview")
def preview(proposal_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    pr, p = projects.require_proposal(db, ctx, proposal_id)
    return explore.preview(db, ctx, p, pr)


@router.get("/projects/{project_id}/explore")
def explore_summary(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return explore.summary(db, projects.require_project(db, ctx, project_id))
