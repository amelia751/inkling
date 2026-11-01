"""Drop plans, collections and dataset structure (todo13 Milestone 2, §5 contracts).

    GET  /api/v1/drops/{id}/plan            → the plan and where it stands (person, agent)
    PUT  /api/v1/drops/{id}/plan            {actions} → "Change" before apply (person, agent)
    POST /api/v1/drops/{id}/apply           {actions?} → apply (person; an agent only D6-safe plans)
    POST /api/v1/drops/{id}/undo            → within the undo window (person)
    GET  /api/v1/datasets/{id}/structure    ?branch= → `structure.json` (draft, or an agent branch)
    PUT  /api/v1/datasets/{id}/structure    {structure, baseHash?} → person: the draft (a published
                                            dataset gets a proposal); agent: its work/agent-* branch,
                                            with the diff against the draft
    POST /api/v1/datasets/{id}/structure/accept {branch} → a person takes an agent's proposal
    GET  /api/v1/projects/{p}/datasets/{d}/collections  → the dataset's collections

`POST …/boots` gains `collectionId` (routes/boots.py, kernel/boots.py). Worker routes for the
archive unpack job are in `routes/unpack.py`.

Feature flags: `API_FEATURE_AUTO_APPLY` and `API_FEATURE_FAST_PATH` gate the kernel's own
applies (kernel/drops_plan.py). The plan routes answer while `API_FEATURE_CHAT_DROPS` is on (a
plan exists only for a drop); structure and collections while any todo13 flag is on. With every
flag off none of these routes answers (§6 J12, §7.4 rollback: drops already made stay as Files).
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import collections, drops_plan, features, projects, structure

router = APIRouter(prefix="/api/v1")
PLANS = [Depends(features.require("chat_drops"))]
TODO13 = [Depends(features.require_any())]


@router.get("/drops/{drop_id}/plan", dependencies=PLANS)
def get_plan(drop_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return drops_plan.state_dict(db, drops_plan.require(db, ctx, drop_id))


@router.put("/drops/{drop_id}/plan", dependencies=PLANS)
def change_plan(drop_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return drops_plan.change(db, ctx, drops_plan.require(db, ctx, drop_id), body.get("actions"))  # type: ignore[arg-type]


@router.post("/drops/{drop_id}/apply", dependencies=PLANS)
def apply_plan(drop_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.principal.startswith(("plugin:", "worker:", "event:")):
        raise HTTPException(403, "only a person or their assistant applies a drop plan")
    row = drops_plan.require(db, ctx, drop_id)
    return drops_plan.apply(db, ctx, row, body.get("actions") if "actions" in body else None)


@router.post("/drops/{drop_id}/undo", dependencies=PLANS)
def undo_plan(drop_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return drops_plan.undo(db, ctx, drops_plan.require(db, ctx, drop_id))


def _dataset(db: Session, ctx: RequestContext, dataset_id: str):
    d, _ = projects.require_dataset(db, ctx, dataset_id)
    if (d.definition or {}).get("seed"):
        raise HTTPException(404, "sample datasets have no structure")
    return d


@router.get("/datasets/{dataset_id}/structure", dependencies=TODO13)
def get_structure(dataset_id: str, branch: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    d = _dataset(db, ctx, dataset_id)
    if ctx.principal.startswith("agent:") and branch is None:
        # The agent reads the draft and, when it has one, its own proposal's diff.
        mine = structure.agent_branch(ctx, d)
        doc = structure.get(db, d)
        theirs = structure.get(db, d, mine)
        return {**doc, "agentBranch": mine, "agentDiff": structure.diff(doc["structure"], theirs["structure"]) if theirs["updatedAt"] else []}
    if branch and branch != structure.DRAFT and ctx.principal.startswith("agent:") and branch != structure.agent_branch(ctx, d):
        raise HTTPException(403, "an agent reads only its own branch")
    doc = structure.get(db, d, branch or structure.DRAFT)
    if branch and branch != structure.DRAFT:
        doc["diff"] = structure.diff(structure.get(db, d)["structure"], doc["structure"])
    return doc


@router.put("/datasets/{dataset_id}/structure", dependencies=TODO13)
def put_structure(dataset_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.principal.startswith(("plugin:", "worker:", "event:")):
        raise HTTPException(403, "only a person or their assistant writes a dataset structure")
    d = _dataset(db, ctx, dataset_id)
    if not ctx.principal.startswith("agent:"):
        projects.require_project(db, ctx, d.project_id, write=True)
    status, out = structure.put(db, ctx, d, body.get("structure"), body.get("baseHash"))
    if status >= 400:
        db.rollback()
    return JSONResponse(out, status_code=status)


@router.post("/datasets/{dataset_id}/structure/accept", dependencies=TODO13)
def accept_structure(dataset_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    d = _dataset(db, ctx, dataset_id)
    projects.require_project(db, ctx, d.project_id, write=True)
    return structure.accept(db, ctx, d, str(body.get("branch") or ""))


@router.get("/projects/{project_id}/datasets/{dataset_id}/collections", dependencies=TODO13)
def list_collections(project_id: str, dataset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    d, p = projects.require_dataset(db, ctx, dataset_id)
    if p.id != project_id:
        raise HTTPException(404, "no such dataset in this project")
    collections.ensure(db, None, d)
    return {"datasetId": d.id, "collections": collections.list_dicts(db, d)}
