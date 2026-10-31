"""Control-plane routes (todo2 Phase 5, docs/plugins.md §7)."""

from __future__ import annotations

import json

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import audit
from ..plugins import artifacts, catalog, installer, policy

router = APIRouter(prefix="/api/v1")

# Session-token scopes (dev header identities have none and may do everything):
#   plugins.read    search, inspect, workspace plugins/capabilities, install requests
#   plugins.manage  plan, stage, activate (low risk only), configure, disable, rollback, reject
#   plugins.author  build generated artifacts (§9)
#   plugins.approve approve installs and grant permissions — never given to agent sessions
MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
DOC_CHARS = 20_000


def _need(ctx: RequestContext, scope: str) -> None:
    if not ctx.allows(scope):
        raise HTTPException(403, f"this session lacks the {scope} scope")


def _ws(ctx: RequestContext, workspace_id: str, scope: str = "plugins.manage") -> RequestContext:
    # Token sessions are bound to their workspace; dev header identities may address any.
    if ctx.scopes and workspace_id != ctx.workspace_id:
        raise HTTPException(403, "session is bound to another workspace")
    _need(ctx, scope)
    return RequestContext(workspace_id, ctx.principal, ctx.correlation_id, ctx.idempotency_key, ctx.scopes, ctx.profile, ctx.on_behalf_of)


def _visible(ctx: RequestContext, plugin_id: str, version: str | None = None) -> catalog.Entry:
    e = catalog.get(plugin_id, version)
    if e is None or not e.visible_to(ctx.workspace_id):
        raise HTTPException(404, f"{plugin_id} is not in the registry")
    return e


@router.get("/plugins")
def search(q: str | None = None, capability: str | None = None, mediaType: str | None = None, ctx: RequestContext = Depends(get_context)):
    _need(ctx, "plugins.read")
    return {"plugins": catalog.search(q, capability, mediaType, workspace_id=ctx.workspace_id)}


@router.post("/plugins/artifacts")
async def build_artifact(request: Request, base: str | None = None, dryRun: bool = False, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """A tarball of a plugin package → checks, and unless `dryRun`, a signed `generated` registry entry (§9)."""
    _need(ctx, "plugins.author")
    if not dryRun and ctx.principal.startswith("agent:"):
        # todo10 Phase 7: a sandbox's package is only checked; the bundle that gets registered is
        # the worker's rebuild of the source (POST /api/v1/boundary/builds).
        raise HTTPException(403, "agents register plugins through /api/v1/boundary/builds (our rebuild); this route only dry-runs for them")
    data = await request.body()
    if len(data) > MAX_ARTIFACT_BYTES:
        raise HTTPException(413, "artifact too large")
    out = artifacts.build(data, ctx, base=base, dry_run=dryRun)
    if not dryRun:
        audit.record(db, ctx, "plugins.artifact", target=f"{out['pluginId']}@{out['version']}", after={k: out.get(k) for k in ("artifactDigest", "ok", "errors", "registered")})
    return out


@router.get("/plugins/{plugin_id}/docs")
def docs(plugin_id: str, version: str | None = None, ctx: RequestContext = Depends(get_context)):
    """README and skills, fetched lazily by agents (§8.2). Plugin-authored text: callers treat it as untrusted."""
    _need(ctx, "plugins.read")
    e = _visible(ctx, plugin_id, version)
    d = catalog.package_dir(e)
    out: dict = {"id": e.id, "version": e.version, "trustTier": e.trust_tier, "readme": None, "skills": []}
    if d and d.is_dir():
        if (d / "README.md").is_file():
            out["readme"] = (d / "README.md").read_text(errors="replace")[:DOC_CHARS]
        for f in sorted((d / "skills").glob("*/SKILL.md")) if (d / "skills").is_dir() else []:
            out["skills"].append({"name": f.parent.name, "content": f.read_text(errors="replace")[:DOC_CHARS]})
    return out


@router.get("/plugins/{plugin_id}")
def inspect(plugin_id: str, version: str | None = None, ctx: RequestContext = Depends(get_context)):
    _need(ctx, "plugins.read")
    e = _visible(ctx, plugin_id, version)
    out = {**e.summary(), "versions": [v.version for v in catalog.versions(plugin_id)], "manifest": e.manifest}
    # Declarative UI (ui/contributions.json) travels as data: the web registers it at runtime,
    # so activating a plugin needs no web deploy.
    rel = (e.manifest.get("ui") or {}).get("contributions")
    d = catalog.package_dir(e)
    if rel and d and (d / rel).is_file():
        out["contributions"] = json.loads((d / rel).read_text())
    return out


@router.get("/workspaces/{workspace_id}/plugins")
def installed(workspace_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _ws(ctx, workspace_id, "plugins.read")
    state = installer.workspace_state(db, c)
    out = []
    for p in state["plugins"]:
        m = installer.manifest_of(db, p["pluginId"], p["version"])
        out.append({**p, "name": m.get("name"), "permissions": policy.report(db, c.workspace_id, p["pluginId"], p["version"], m), "config": installer.current_config(db, c.workspace_id, p["pluginId"]), "versions": [v.version for v in catalog.versions(p["pluginId"])]})
    return {"plugins": out, "history": installer.history(db, c)}


@router.get("/workspaces/{workspace_id}/capabilities")
def capabilities(workspace_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """What the active plugins in this workspace can do: one row per capability, summaries only."""
    c = _ws(ctx, workspace_id, "plugins.read")
    installer.bootstrap(db, c)
    rows = []
    for inst, m in installer.active_manifests(db, c.workspace_id):
        for cap in m.get("capabilities") or []:
            rows.append({"capability": cap["id"], "pluginId": inst.plugin_id, "version": inst.version, "tool": cap.get("tool"), "mediaTypes": cap.get("mediaTypes") or [], "description": cap.get("description") or m.get("description")})
    return {"capabilities": sorted(rows, key=lambda r: (r["capability"], r["pluginId"]))}


@router.post("/workspaces/{workspace_id}/plugins/plan")
def plan(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _ws(ctx, workspace_id)
    return installer.request_dict(installer.plan(db, c, str(body["pluginId"]), body.get("version")))


@router.get("/workspaces/{workspace_id}/plugins/requests/{request_id}")
def get_request(workspace_id: str, request_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return installer.request_dict(installer.get_request(db, _ws(ctx, workspace_id, "plugins.read"), request_id))


@router.post("/workspaces/{workspace_id}/plugins/stage")
def stage(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _ws(ctx, workspace_id)
    r = installer.stage(db, c, str(body["requestId"]))
    if r.state == "STAGED":
        r = installer.validate(db, c, r.id)
    return installer.request_dict(r)


@router.post("/workspaces/{workspace_id}/plugins/approve")
def approve(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _ws(ctx, workspace_id, "plugins.approve")
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
    return {"granted": installer.grant_permissions(db, _ws(ctx, workspace_id, "plugins.approve"), str(body["pluginId"]), [str(p) for p in body.get("permissions") or []])}
