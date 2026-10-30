"""Kernel routes (docs/plugins.md §6). Workspace, principal, correlation id and idempotency
key come from `get_context` (headers / session token), never from bodies."""

from __future__ import annotations

import mimetypes
import re

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.orm import Session

from ..context import RequestContext, ensure_workspace, get_context, issue_session
from ..db import get_session
from ..kernel import annotations, assets, audit, events, gateway, jobs, secrets
from ..models import WorkspaceEnvironment
from ..plugins import installer

router = APIRouter(prefix="/api")


# ---- Annotations (also the Studio's existing /api/annotations/:projectId endpoints) ------


def _project_ctx(ctx: RequestContext, project_id: str) -> RequestContext:
    """Dev compatibility: the seed server keyed documents by project id = workspace id."""
    if not re.fullmatch(r"[a-z0-9-]+", project_id):
        raise HTTPException(400, "bad project id")
    if ctx.scopes and ctx.workspace_id != project_id:
        raise HTTPException(403, "session token is bound to another workspace")
    return RequestContext(project_id, ctx.principal, ctx.correlation_id, ctx.idempotency_key, ctx.scopes, ctx.profile)


@router.get("/annotations/{project_id}")
def get_annotations(project_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project_ctx(ctx, project_id)
    ensure_workspace(db, c.workspace_id)
    return annotations.get_document(db, c)


@router.put("/annotations/{project_id}")
def put_annotations(project_id: str, doc: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project_ctx(ctx, project_id)
    ensure_workspace(db, c.workspace_id)
    return annotations.put_document(db, c, doc)


@router.get("/v1/annotations")
def list_annotations(item_id: str | None = None, label: str | None = None, limit: int = 1000, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if not ctx.allows("annotations.read"):
        raise HTTPException(403, "this session can't read annotations")
    return {"annotations": annotations.list_annotations(db, ctx, item_id, label, limit)}


@router.post("/v1/annotations/{annotation_id}/review")
def review(annotation_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
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
    a = assets.get_asset(db, ctx, path)
    f = assets.asset_file(a)
    return FileResponse(f, media_type=a.media_type or mimetypes.guess_type(str(f))[0])


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
def asset_content(asset_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Bytes of an asset for a plugin worker (scoped token with assets.read)."""
    if not ctx.allows("assets.read"):
        raise HTTPException(403, "this session can't read assets")
    a = assets.get_asset(db, ctx, asset_id)
    return FileResponse(assets.asset_file(a), media_type=a.media_type)


# ---- Command gateway and jobs ----------------------------------------------------------------


@router.post("/v1/commands")
def command(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    if not ctx.allows("commands.invoke"):
        raise HTTPException(403, "this session can't invoke commands")
    status, out = gateway.dispatch(db, ctx, body)
    return JSONResponse(out, status_code=status)


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
    c = _project_ctx(ctx, workspace_id)
    ensure_workspace(db, c.workspace_id)
    return installer.workspace_state(db, c)


@router.put("/v1/workspaces/{workspace_id}/environment")
def put_environment(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _project_ctx(ctx, workspace_id)
    ensure_workspace(db, c.workspace_id)
    row = db.get(WorkspaceEnvironment, c.workspace_id) or WorkspaceEnvironment(workspace_id=c.workspace_id, revision=0)
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
    token = issue_session(db, f"agent:{body.get('agent', 'builder')}", ctx.workspace_id, scopes, int(body.get("ttlSeconds") or 3600), body.get("profile"))
    audit.record(db, ctx, "sessions.issue", after={"scopes": scopes, "profile": body.get("profile")})
    return {"token": token, "workspaceId": ctx.workspace_id, "scopes": scopes}

