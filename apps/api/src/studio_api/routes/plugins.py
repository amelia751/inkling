"""Control-plane routes (todo2 Phase 5, docs/plugins.md §7)."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..plugins import catalog, installer, policy

router = APIRouter(prefix="/api/v1")


def _ws(ctx: RequestContext, workspace_id: str) -> RequestContext:
    # Token sessions are bound to their workspace; dev header identities may address any.
    if ctx.scopes and workspace_id != ctx.workspace_id:
        raise HTTPException(403, "session is bound to another workspace")
    return RequestContext(workspace_id, ctx.principal, ctx.correlation_id, ctx.idempotency_key, ctx.scopes, ctx.profile)


@router.get("/plugins")
def search(q: str | None = None, capability: str | None = None, mediaType: str | None = None):
    return {"plugins": catalog.search(q, capability, mediaType)}


@router.get("/plugins/{plugin_id}")
def inspect(plugin_id: str, version: str | None = None):
    e = catalog.get(plugin_id, version)
    if e is None:
        raise HTTPException(404, f"{plugin_id} is not in the registry")
    return {**e.summary(), "versions": [v.version for v in catalog.versions(plugin_id)], "manifest": e.manifest}


@router.get("/workspaces/{workspace_id}/plugins")
def installed(workspace_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _ws(ctx, workspace_id)
    state = installer.workspace_state(db, c)
    out = []
    for p in state["plugins"]:
        m = installer.manifest_of(db, p["pluginId"], p["version"])
        out.append({**p, "name": m.get("name"), "permissions": policy.report(db, c.workspace_id, p["pluginId"], p["version"], m), "config": installer.current_config(db, c.workspace_id, p["pluginId"]), "versions": [v.version for v in catalog.versions(p["pluginId"])]})
    return {"plugins": out, "history": installer.history(db, c)}


@router.post("/workspaces/{workspace_id}/plugins/plan")
def plan(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _ws(ctx, workspace_id)
    return installer.request_dict(installer.plan(db, c, str(body["pluginId"]), body.get("version")))


@router.get("/workspaces/{workspace_id}/plugins/requests/{request_id}")
def get_request(workspace_id: str, request_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return installer.request_dict(installer.get_request(db, _ws(ctx, workspace_id), request_id))


@router.post("/workspaces/{workspace_id}/plugins/stage")
def stage(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _ws(ctx, workspace_id)
    r = installer.stage(db, c, str(body["requestId"]))
    if r.state == "STAGED":
        r = installer.validate(db, c, r.id)
    return installer.request_dict(r)


@router.post("/workspaces/{workspace_id}/plugins/approve")
def approve(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _ws(ctx, workspace_id)
    return installer.request_dict(installer.approve(db, c, str(body["requestId"]), [str(p) for p in body.get("grantOptional") or []]))


@router.post("/workspaces/{workspace_id}/plugins/reject")
def reject(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return installer.request_dict(installer.reject(db, _ws(ctx, workspace_id), str(body["requestId"]), str(body.get("reason") or "rejected by user")))


@router.post("/workspaces/{workspace_id}/plugins/activate")
def activate(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return installer.request_dict(installer.activate(db, _ws(ctx, workspace_id), str(body["requestId"])))


@router.post("/workspaces/{workspace_id}/plugins/disable")
def disable(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    r = installer.disable(db, _ws(ctx, workspace_id), str(body["pluginId"]))
    return {"pluginId": r.plugin_id, "version": r.version, "state": r.state}


@router.post("/workspaces/{workspace_id}/plugins/rollback")
def rollback(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    r = installer.rollback(db, _ws(ctx, workspace_id), str(body["pluginId"]))
    return {"pluginId": r.plugin_id, "version": r.version, "state": r.state, "configRevision": r.config_revision}


@router.post("/workspaces/{workspace_id}/plugins/configure")
def configure(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return installer.configure(db, _ws(ctx, workspace_id), str(body["pluginId"]), dict(body.get("config") or {}))


@router.post("/workspaces/{workspace_id}/plugins/grant")
def grant(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return {"granted": installer.grant_permissions(db, _ws(ctx, workspace_id), str(body["pluginId"]), [str(p) for p in body.get("permissions") or []])}
