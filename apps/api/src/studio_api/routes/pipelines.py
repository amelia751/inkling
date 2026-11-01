"""Pipeline gateway routes (todo12 §4 M1, docs/pipeline.md §15): the public face of apps/pipeline.

    GET  /api/v1/projects/{id}/pipeline-runs?state=a,b&cursor=   → {runs, next_cursor?}
    POST /api/v1/pipeline-runs                  start a run (Idempotency-Key)
    GET  /api/v1/pipeline-runs/{id}             the run, with `review.can_approve` decided here for the caller
    GET  /api/v1/pipeline-runs/{id}/events      SSE: this run's events (Last-Event-ID)
    POST /api/v1/pipeline-runs/{id}/cancel      request cancel
    POST /api/v1/pipeline-runs/{id}/approve     {candidate_digest} → {approval_id, state?, run?}
    POST /api/v1/pipelines/{id}/validate        compile / check a definition

Every route resolves the caller's workspace from the request context and forwards to the
pipeline's private API with an api-signed JWT (kernel/pipeline_client.py); a run of another
workspace is a 404. The routes are not on the agent allowlist (E10: agents get pipeline
routes in Milestone 4), so agent sessions get 403.

Approve: the caller (a person with `pipelines.approve` and `versioning.approve`) names the
candidate digest they reviewed. A different current digest is a 409. The kernel records the
approval in versioning (`{source_oid: candidate.commit, candidate_digest}`; versioning refuses
agents and the review's author), takes the approval's `id` from `review.approvals[]` (the one
by this reviewer on this source), then tells the pipeline `{run_id, approval_id,
candidate_digest}`, which starts `PublishWorkflow` with the approval id as its workflow id.
Versioning keeps one approval per (reviewer, source, target), so a retry by the same person
gets the same id and the pipeline starts nothing new.
"""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session, session_scope
from ..kernel import audit, events, pipeline_client, projects
from ..kernel.versioning import service as vservice
from ..models import DatasetRepo, PluginEvent

router = APIRouter(prefix="/api/v1")

READ, RUN, APPROVE = "pipelines.read", "pipelines.run", "pipelines.approve"
RUN_STATES = ("queued", "running", "awaiting_review", "publishing", "published", "rejected", "failed", "cancelled")
CLOSED_REVIEWS = {"MERGED", "CLOSED", "REJECTED"}
SSE_POLL_S = 0.5
SSE_MAX_S = 300.0


def _need(ctx: RequestContext, scope: str) -> None:
    if not ctx.allows(scope):
        raise HTTPException(403, f"this session lacks {scope}")


def _client() -> pipeline_client.PipelineClient:
    if not pipeline_client.configured():
        raise HTTPException(503, "the pipeline service isn't configured")
    return pipeline_client.client()


def _call(fn, *args):
    try:
        return fn(*args)
    except pipeline_client.PipelineError as e:
        detail = e.body.get("detail", e.body) if isinstance(e.body, dict) else e.body
        raise HTTPException(e.status, detail) from None


def _run(ctx: RequestContext, run_id: str) -> dict:
    run = _call(_client().get_run, ctx, run_id)
    if not isinstance(run, dict) or run.get("workspace_id", ctx.workspace_id) != ctx.workspace_id:
        raise HTTPException(404, "no such run in this workspace")
    return run


def can_approve(ctx: RequestContext, run: dict) -> bool:
    """A person with the approve scopes, on a run waiting for review whose review is still open."""
    review = run.get("review") or {}
    if not ctx.principal.startswith("user:") or not (ctx.allows(APPROVE) and ctx.allows("versioning.approve")):
        return False
    if run.get("state") != "awaiting_review" or not run.get("candidate") or not review.get("review_id"):
        return False
    return str(review.get("status") or "").upper() not in CLOSED_REVIEWS and not review.get("approved_by")


def _with_review(ctx: RequestContext, run: dict) -> dict:
    if isinstance(run.get("review"), dict):
        run = {**run, "review": {**run["review"], "can_approve": can_approve(ctx, run)}}
    return run


def _approval(review: dict, source: str, reviewer: str | None) -> dict | None:
    """The approval on `source`, by `reviewer` when given (else the latest)."""
    mine = [a for a in review.get("approvals") or [] if a.get("approved_source_oid") == source and (reviewer is None or a.get("reviewer_id") == reviewer)]
    return mine[-1] if mine else None


def _dataset(db: Session, ctx: RequestContext, ref: str) -> str:
    """The kernel dataset id of a candidate's `dataset_id` (the kernel's id, or the versioning repo id)."""
    if db.get(DatasetRepo, (ctx.workspace_id, ref)) is not None:
        return ref
    row = db.scalar(select(DatasetRepo).where(DatasetRepo.workspace_id == ctx.workspace_id, DatasetRepo.repo_id == ref))
    if row is None:
        raise HTTPException(409, "the candidate's dataset isn't versioned in this workspace")
    return row.dataset_id


@router.get("/projects/{project_id}/pipeline-runs")
def list_runs(project_id: str, state: str | None = None, cursor: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _need(ctx, READ)
    p = projects.require_project(db, ctx, project_id)
    states = [s.strip() for s in (state or "").split(",") if s.strip()]
    if any(s not in RUN_STATES for s in states):
        raise HTTPException(422, f"state must be among {', '.join(RUN_STATES)}")
    page = _call(_client().list_runs, ctx.for_scope(p.id, ctx.task_id), p.id, ",".join(states) or None, cursor)
    runs = [r for r in (page.get("runs") or []) if r.get("workspace_id", p.id) == p.id]
    out: dict = {"runs": runs}
    if page.get("next_cursor"):
        out["next_cursor"] = page["next_cursor"]
    return out


@router.post("/pipeline-runs")
def start_run(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _need(ctx, RUN)
    project_id = body.get("project_id") or ctx.workspace_id
    p = projects.require_project(db, ctx, str(project_id), write=True)
    if not isinstance(body.get("definition_id"), str):
        raise HTTPException(422, "definition_id is required")
    fwd = {**body, "workspace_id": ctx.workspace_id, "project_id": p.id, "actor": ctx.principal, "idempotency_key": ctx.idempotency_key}
    run = _call(_client().create_run, ctx, fwd, ctx.idempotency_key)
    audit.record(db, ctx, "pipelines.run.start", target=f"pipeline-run:{run.get('run_id')}", after={"definition": body["definition_id"]})
    return JSONResponse(run, status_code=202)


@router.get("/pipeline-runs/{run_id}")
def get_run(run_id: str, ctx: RequestContext = Depends(get_context)):
    _need(ctx, READ)
    return _with_review(ctx, _run(ctx, run_id))


@router.post("/pipeline-runs/{run_id}/cancel")
def cancel_run(run_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _need(ctx, RUN)
    _run(ctx, run_id)
    out = _call(_client().cancel_run, ctx, run_id, ctx.idempotency_key)
    audit.record(db, ctx, "pipelines.run.cancel", target=f"pipeline-run:{run_id}")
    return out


@router.post("/pipeline-runs/{run_id}/approve")
def approve_run(run_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if not ctx.principal.startswith("user:"):
        raise HTTPException(403, "only a person approves a pipeline run")
    _need(ctx, APPROVE)
    digest = body.get("candidate_digest")
    if not isinstance(digest, str) or not digest:
        raise HTTPException(422, "candidate_digest is required")
    run = _run(ctx, run_id)
    candidate, review = run.get("candidate") or {}, run.get("review") or {}
    if digest != candidate.get("output_manifest_digest"):
        raise HTTPException(409, {"code": "stale_candidate", "detail": "the candidate changed since you reviewed it", "current_digest": candidate.get("output_manifest_digest")})
    if not review.get("review_id") or not candidate.get("commit"):
        raise HTTPException(409, {"code": "not_awaiting_review", "detail": f"the run is {run.get('state')}"})
    dataset = _dataset(db, ctx, str(candidate.get("dataset_id") or ""))
    if run.get("state") in ("publishing", "published"):
        # Already approved: the same answer again, without a second approval or publish.
        status, current = vservice.run(db, ctx, "review.get", dataset, {"review_id": review["review_id"]})
        prior = _approval(current, candidate["commit"], ctx.principal) or _approval(current, candidate["commit"], None) if status < 400 else None
        if prior is None:
            raise HTTPException(409, {"code": "not_awaiting_review", "detail": f"the run is {run['state']}"})
        return {"approval_id": prior["id"], "state": run["state"]}
    if run.get("state") != "awaiting_review":
        raise HTTPException(409, {"code": "not_awaiting_review", "detail": f"the run is {run.get('state')}"})
    status, out = vservice.run(db, ctx, "review.approve", dataset, {"review_id": review["review_id"], "source_oid": candidate["commit"], "candidate_digest": digest})
    if status >= 400:
        db.commit()  # keep the audit entry of the refusal
        code = out.get("code") if isinstance(out, dict) else None
        raise HTTPException(409 if status == 409 else status, {"code": code or "versioning", "detail": out.get("detail") if isinstance(out, dict) else out})
    approval = _approval(out, candidate["commit"], ctx.principal)
    if approval is None or not approval.get("id"):
        raise HTTPException(502, "versioning recorded the approval but returned no approval id")
    aid = str(approval["id"])
    audit.record(db, ctx, "pipelines.run.approve", target=f"pipeline-run:{run_id}", after={"approvalId": aid, "candidateDigest": digest, "commit": candidate["commit"], "reviewId": review["review_id"]})
    db.commit()  # the approval is recorded; telling the pipeline is idempotent by approval id
    res = _call(_client().approve, ctx, {"run_id": run_id, "approval_id": aid, "candidate_digest": digest})
    out_body: dict = {"approval_id": aid}
    state = (res or {}).get("state") if isinstance(res, dict) else None
    if state:
        out_body["state"] = state
    if isinstance(res, dict) and isinstance(res.get("run"), dict):
        out_body["run"] = _with_review(ctx, res["run"])
    return out_body


@router.post("/pipelines/{definition_id}/validate")
def validate_definition(definition_id: str, body: dict = Body(default={}), ctx: RequestContext = Depends(get_context)):
    _need(ctx, READ)
    return _call(_client().validate_definition, ctx, definition_id, {**body, "workspace_id": ctx.workspace_id})


@router.get("/pipeline-runs/{run_id}/events")
async def run_events(run_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """This run's events from the outbox (same polling as the project stream)."""
    _need(ctx, READ)
    db.close()
    await asyncio.to_thread(_run, ctx, run_id)
    workspace = ctx.workspace_id
    last = request.headers.get("Last-Event-ID") or request.query_params.get("after")
    types = list(events.PIPELINE_EVENTS)

    def after(cursor: str | None) -> list[tuple[str, str, dict]]:
        with session_scope() as s:
            q = select(PluginEvent).where(PluginEvent.workspace_id == workspace, PluginEvent.type.in_(types))
            cut = s.get(PluginEvent, cursor) if cursor else None
            if cut is not None:
                q = q.where(PluginEvent.created_at >= cut.created_at, PluginEvent.event_id != cut.event_id)
            rows = s.scalars(q.order_by(PluginEvent.created_at).limit(500))
            return [(e.event_id, e.type, e.payload) for e in rows if (e.payload or {}).get("run_id") == run_id]

    async def stream():
        cursor = last
        yield "retry: 3000\n\n"
        waited = 0.0
        while waited < SSE_MAX_S and not await request.is_disconnected():
            for eid, kind, payload in await asyncio.to_thread(after, cursor):
                cursor = eid
                yield f"id: {eid}\nevent: {kind}\ndata: {json.dumps(payload)}\n\n"
            await asyncio.sleep(SSE_POLL_S)
            waited += SSE_POLL_S

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
