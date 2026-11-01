"""Kernel routes (docs/plugins.md §6). Workspace, principal, correlation id and idempotency
key come from `get_context` (headers / session token), never from bodies."""

from __future__ import annotations

import mimetypes
import re

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .. import blobstore
from ..context import RequestContext, ensure_workspace, get_context, issue_session, scope_of
from ..db import get_session
from ..kernel import annotations, assets, audit, events, gateway, jobs, projects, secrets
from ..models import WorkspaceEnvironment
from ..naming import ns
from ..plugins import installer
from ..streaming import blob_response

router = APIRouter(prefix="/api")


# ---- Annotations (also the Studio's existing /api/annotations/:projectId endpoints) ------


def task_ctx(db: Session, ctx: RequestContext, task_id: str) -> RequestContext:
    """The legacy `/annotations/:id` and `/environments/:id` ids are task ids (todo6 D3): a
    task of a project resolves to the project's workspace, and a seed (or older workspace)
    id is its own workspace and task. Project membership is checked when there is one."""
    if not re.fullmatch(r"[a-z0-9-]+", task_id):
        raise HTTPException(400, "bad project id")
    workspace, task = scope_of(db, task_id)
    if ctx.scopes and ctx.workspace_id != workspace:
        raise HTTPException(403, "session token is bound to another workspace")
    c = ctx.for_scope(workspace, task)
    ensure_workspace(db, workspace)
    projects.project_of_scope(db, c)
    return c


def _project_ctx(ctx: RequestContext, project_id: str, db: Session) -> RequestContext:
    return task_ctx(db, ctx, project_id)


@router.get("/annotations/{project_id}")
def get_annotations(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project_ctx(ctx, project_id, db)
    return annotations.get_document(db, c)


@router.put("/annotations/{project_id}")
def put_annotations(project_id: str, doc: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.profile == "plugin":  # plugins write through POST /v1/annotations, never the whole document
        raise HTTPException(403, "plugin sessions can't replace the annotation document")
    c = _project_ctx(ctx, project_id, db)
    return annotations.put_document(db, c, doc)


@router.get("/v1/annotations")
def list_annotations(item_id: str | None = None, label: str | None = None, limit: int = 1000, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if not ctx.allows("annotations.read"):
        raise HTTPException(403, "this session can't read annotations")
    return {"annotations": annotations.list_annotations(db, ctx, item_id, label, limit)}


@router.post("/v1/annotations")
def write_annotations(request: Request, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """`annotations.write` for plugin sessions (studio_plugin_sdk `ctx.annotations.write`).
    Bound to the running job named in `X-Job-Id`; the kernel stamps identity and provenance."""
    if ctx.profile != "plugin" or not ctx.allows("annotations.write"):
        raise HTTPException(403, "this session can't write annotations (plugin sessions with annotations.write only)")
    job_id = request.headers.get("X-Job-Id") or ""
    if not job_id:
        raise HTTPException(422, "X-Job-Id must name the job this write belongs to")
    job = jobs.get(db, ctx, job_id)
    ids = annotations.plugin_write(db, ctx, job, body.get("annotations") or [], key=ctx.idempotency_key)
    return {"annotationIds": ids}


@router.post("/v1/annotations/{annotation_id}/review")
def review(annotation_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.profile == "plugin":
        raise HTTPException(403, "plugins can't review annotations")
    return annotations.set_review(db, ctx, annotation_id, str(body.get("status")))


# ---- Assets ----------------------------------------------------------------------------------


@router.get("/v1/assets")
def list_assets(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if not ctx.allows("assets.read"):
        raise HTTPException(403, "this session can't read assets")
    return {"assets": assets.list_assets(db, ctx)}


@router.get("/v1/assets/{asset_id}/url")
def signed_url(asset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if not ctx.allows("assets.read"):
        raise HTTPException(403, "this session can't read assets")
    a = assets.get_asset(db, ctx, asset_id)
    return {"url": assets.sign_path(ctx.workspace_id, a.path), "mediaType": a.media_type}


@router.post("/v1/assets/url-token")
def url_token(ctx: RequestContext = Depends(get_context)):
    """A workspace-wide URL token; the web's assetUrl() builds signed URLs from it."""
    return assets.workspace_url_token(ctx.workspace_id)


@router.get("/v1/assets/{workspace_id}/files/{path:path}")
def asset_file(workspace_id: str, path: str, exp: str, sig: str, request: Request, db: Session = Depends(get_session)):
    assets.verify(workspace_id, path, exp, sig)
    ctx = RequestContext(workspace_id, "signed-url", "")
    ensure_workspace(db, workspace_id)
    if (key := assets.companion_key(db, ctx, path)) is not None:
        return blob_response(blobstore.assets(), key, mimetypes.guess_type(path)[0] or "application/octet-stream", request)
    a = assets.get_asset(db, ctx, path)
    return blob_response(assets.store_of(a.path), assets.asset_key(a), a.media_type or mimetypes.guess_type(a.path)[0] or "application/octet-stream", request)


@router.post("/v1/artifacts")
async def create_artifact(request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if not ctx.allows("assets.write"):
        raise HTTPException(403, "this session can't write artifacts")
    data = await request.body()
    if len(data) > 64 * 1024 * 1024:
        raise HTTPException(413, "artifact too large")
    art = assets.create_artifact(db, ctx, data, request.headers.get("Content-Type", "application/octet-stream"), request.query_params.get("source"))
    return {"artifactId": art.id, "mediaType": art.media_type}


@router.get("/v1/assets/{asset_id}/content")
def asset_content(asset_id: str, request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Bytes of an asset for a plugin worker (scoped token with assets.read)."""
    if not ctx.allows("assets.read"):
        raise HTTPException(403, "this session can't read assets")
    a = assets.get_asset(db, ctx, asset_id)
    return blob_response(assets.store_of(a.path), assets.asset_key(a), a.media_type, request)


# ---- Command gateway and jobs ----------------------------------------------------------------


@router.post("/v1/commands")
def command(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if not ctx.allows("commands.invoke"):
        raise HTTPException(403, "this session can't invoke commands")
    if ctx.principal.startswith("agent:") and str(body.get("tool") or "") == ns("versioning.checkout"):
        # A checkout returns samples, annotation payloads and object URLs: data, not shell (todo10 §6.3).
        raise HTTPException(403, "agent sessions can't check out dataset contents; use the filtered annotation view")
    try:
        status, out = gateway.dispatch(db, ctx, body)
    except gateway.Denied as d:
        return JSONResponse({"detail": d.detail}, status_code=d.status)
    if ctx.principal.startswith("agent:") and isinstance(out, dict) and ("job" in out or "jobs" in out):
        out = _agent_view(db, out)
    return JSONResponse(out, status_code=status)


def _agent_view(db: Session, out: dict) -> dict:
    """What an agent sees of a gateway response (todo10 §6.3): job summaries (counts, states,
    error classes) and annotation ids, never outputs or error text."""
    from ..kernel import boundary
    from ..models import PluginJob

    def one(j: dict | None) -> dict | None:
        row = db.get(PluginJob, j.get("jobId")) if isinstance(j, dict) else None
        if row is None:
            return None
        ids = [x for x in ((row.result or {}).get("annotationIds") or []) if isinstance(x, str)][:1000] if row.state == "succeeded" else []
        return {**boundary.summary(row), "annotationIds": ids}

    view: dict = {k: out[k] for k in ("replayed", "estimateUsd") if k in out}
    if "job" in out:
        view["job"] = one(out["job"])
    if "jobs" in out:
        view["jobs"] = [one(j) for j in out["jobs"] or []]
    return view


@router.get("/v1/jobs")
def list_jobs(state: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"jobs": jobs.list_jobs(db, ctx, state)}


@router.get("/v1/jobs/{job_id}")
def get_job(job_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return jobs.job_dict(jobs.get(db, ctx, job_id))


@router.post("/v1/jobs/{job_id}/cancel")
def cancel_job(job_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return jobs.job_dict(jobs.cancel(db, ctx, job_id))


@router.post("/v1/jobs/{job_id}/retry")
def retry_job(job_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return jobs.job_dict(jobs.retry(db, ctx, job_id))


# ---- Events, secrets, workspace, audit, sessions -------------------------------------------


@router.post("/v1/events")
def publish_event(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if not ctx.allows("events.publish"):
        raise HTTPException(403, "this session can't publish events")
    if str(body.get("type")) in events.PROJECT_EVENTS:
        raise HTTPException(403, "project events are published by the kernel only")
    depth = int(body.get("depth") or 0)
    ev = events.publish(db, ctx, str(body.get("type")), body.get("payload") or {}, source=ctx.principal, depth=depth, idempotency_key=ctx.idempotency_key)
    return {"eventId": ev.event_id if ev else None, "duplicate": ev is None}


@router.get("/v1/secrets")
def secret_names(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"names": secrets.names(db, ctx)}


@router.put("/v1/secrets/{name}")
def put_secret(name: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.scopes:  # agent / plugin sessions never write secrets
        raise HTTPException(403, "only workspace users can set secrets")
    secrets.put(db, ctx, name, str(body.get("value", "")))
    return Response(status_code=204)


@router.delete("/v1/secrets/{name}")
def delete_secret(name: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if ctx.scopes:
        raise HTTPException(403, "only workspace users can delete secrets")
    secrets.delete(db, ctx, name)
    return Response(status_code=204)


@router.post("/v1/secrets/proxy")
def secret_proxy(body: dict = Body(...), request: Request = None, db: Session = Depends(get_session)):  # type: ignore[assignment]
    """The broker: a plugin's use token + an outbound request → the provider's response."""
    token = (request.headers.get("X-Secret-Use-Token") if request else None) or ""
    r = secrets.proxy(db, token, str(body.get("method", "POST")), str(body.get("url", "")), headers=body.get("headers") or {}, body=(body.get("body") or "").encode() if isinstance(body.get("body"), str) else None, inject=body.get("inject") or "Authorization", scheme=body.get("scheme", "Bearer"))
    return Response(content=r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))


@router.get("/v1/workspaces/{workspace_id}/state")
def workspace_state(workspace_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project_ctx(ctx, workspace_id, db)
    return installer.workspace_state(db, c)


@router.put("/v1/workspaces/{workspace_id}/environment")
def put_environment(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project_ctx(ctx, workspace_id, db)
    row = db.get(WorkspaceEnvironment, (c.workspace_id, c.task)) or WorkspaceEnvironment(workspace_id=c.workspace_id, task_id=c.task, revision=0)
    db.add(row)
    before = row.environment
    row.environment, row.revision, row.author = body.get("environment"), row.revision + 1, c.principal
    audit.record(db, c, "workspace.environment", before=before, after=row.environment)
    return {"revision": row.revision}


@router.get("/v1/audit")
def audit_log(action: str | None = None, limit: int = 200, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"entries": audit.entries(db, ctx, limit, action)}


@router.post("/v1/sessions")
def new_session(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """A workspace user mints a narrower session token (e.g. for an agent run). Scopes can only shrink."""
    if ctx.scopes:
        raise HTTPException(403, "session tokens can't mint other tokens")
    scopes = [str(s) for s in body.get("scopes") or []]
    # The task the person has open (X-Workspace-Id names it), so the agent may write its setup (todo11 D2.1).
    token = issue_session(db, f"agent:{body.get('agent', 'builder')}", ctx.workspace_id, scopes, int(body.get("ttlSeconds") or 3600), body.get("profile"), on_behalf_of=ctx.principal, task_id=ctx.task_id)
    audit.record(db, ctx, "sessions.issue", after={"scopes": scopes, "profile": body.get("profile")})
    return {"token": token, "workspaceId": ctx.workspace_id, "scopes": scopes}

