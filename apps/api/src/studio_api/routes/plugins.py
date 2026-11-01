"""Control-plane routes (todo2 Phase 5, docs/plugins.md §7)."""

from __future__ import annotations

import base64
import hashlib
import json

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session
from studio_signing import oci

from ..context import RequestContext, get_context
from ..db import get_session
from ..kernel import audit
from ..plugins import artifacts, catalog, distribution, installer, policy, store

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


def _visible(ctx: RequestContext, db: Session, plugin_id: str, version: str | None = None) -> catalog.Entry:
    e = catalog.get(plugin_id, version, db)
    if e is None or not catalog.visible(db, e, ctx.workspace_id):
        raise HTTPException(404, f"{plugin_id} is not in the registry")
    return e


def _files(ctx: RequestContext, e: catalog.Entry, where: str) -> dict[str, bytes]:
    """The package, verified on this load; a refusal is audited and answered 409 with the reason."""
    try:
        return catalog.load_files(e)
    except oci.ArtifactRefused as x:
        store.audit_refusal(ctx, f"{e.id}@{e.version}", str(x), where=where, manifest_digest=e.manifest_digest)
        raise HTTPException(409, {"message": f"{e.id}@{e.version} was refused: it failed verification", "reason": str(x)}) from x


@router.get("/plugins")
def search(q: str | None = None, capability: str | None = None, mediaType: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _need(ctx, "plugins.read")
    return {"plugins": catalog.search(q, capability, mediaType, workspace_id=ctx.workspace_id, db=db)}


@router.post("/plugins/artifacts")
async def build_artifact(
    request: Request,
    base: str | None = None,
    dryRun: bool = False,
    runId: str | None = None,
    promptHash: str | None = None,
    model: str | None = None,
    sampleDigests: str | None = None,
    ctx: RequestContext = Depends(get_context),
    db: Session = Depends(get_session),
):
    """A tarball of a plugin package → checks, and unless `dryRun`, a signed, content-addressed
    `generated` registry entry with a provenance attestation (§9; todo10 Phase 3). `runId`,
    `promptHash`, `model` and `sampleDigests` go into the attestation."""
    _need(ctx, "plugins.author")
    if not dryRun and ctx.principal.startswith("agent:"):
        # todo10 Phase 7: a sandbox's package is only checked; the bundle that gets registered is
        # the worker's rebuild of the source (POST /api/v1/boundary/builds).
        raise HTTPException(403, "agents register plugins through /api/v1/boundary/builds (our rebuild); this route only dry-runs for them")
    data = await request.body()
    if len(data) > MAX_ARTIFACT_BYTES:
        raise HTTPException(413, "artifact too large")
    claims = artifacts.provenance(runId, promptHash, model, sampleDigests)
    out = artifacts.build(data, ctx, db, base=base, dry_run=dryRun, claims=claims)
    if not dryRun:
        audit.record(db, ctx, "plugins.artifact", target=f"{out['pluginId']}@{out['version']}", after={k: out.get(k) for k in ("artifactDigest", "manifestDigest", "ok", "errors", "registered")})
    return out


# ---- Distribution and promotion (todo10 Phase 8) -------------------------------------------


@router.post("/plugins/import")
async def import_artifacts(request: Request, tier: str = "generated", ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """A tar of an OCI image layout (`oras copy --to-oci-layout`, or GET …/export) → verified,
    stored and registered in this workspace at `tier`. A person's action: `plugins.approve`."""
    _need(ctx, "plugins.approve")
    data = await request.body()
    return {"imported": distribution.import_tar(db, ctx, data, tier=tier)}


@router.get("/plugins/promotions")
def list_promotions(state: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _need(ctx, "plugins.read")
    return {"promotions": distribution.promotions(db, ctx, state)}


@router.post("/plugins/promotions/{promotion_id}/review")
def review_promotion(promotion_id: int, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Approve or reject (`{"decision": "approve" | "reject", "reason"}`); a second person only."""
    _need(ctx, "plugins.approve")
    decision = str(body.get("decision") or "")
    if decision not in ("approve", "reject"):
        raise HTTPException(422, "decision must be approve or reject")
    return distribution.promotion_dict(distribution.review_promotion(db, ctx, promotion_id, decision == "approve", str(body.get("reason") or "")))


@router.get("/plugins/{plugin_id}/export")
def export_artifact(plugin_id: str, version: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The stored artifact as a tar of an OCI image layout (manifest tagged `<version>`, plus
    its signature and attestation referrers), ready for `oras copy -r --from-oci-layout`."""
    _need(ctx, "plugins.approve")
    data, info = distribution.export_tar(db, ctx, plugin_id, version)
    return Response(data, media_type="application/x-tar", headers={"Content-Disposition": f'attachment; filename="{info["pluginId"]}-{info["version"]}.oci.tar"', "X-Manifest-Digest": info["manifestDigest"]})


@router.post("/plugins/{plugin_id}/promotions")
def request_promotion(plugin_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Ask for the next tier (generated → organisation → curated). Anyone who manages plugins
    may ask, the agent included; only a second person approves."""
    _need(ctx, "plugins.manage")
    return distribution.promotion_dict(distribution.request_promotion(db, ctx, plugin_id, str(body["version"]), str(body.get("reason") or "")))


@router.get("/plugins/{plugin_id}/docs")
def docs(plugin_id: str, version: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """README and skills, fetched lazily by agents (§8.2). Plugin-authored text: callers treat it as untrusted."""
    _need(ctx, "plugins.read")
    e = _visible(ctx, db, plugin_id, version)
    files = _files(ctx, e, "docs")
    out: dict = {"id": e.id, "version": e.version, "trustTier": e.trust_tier, "readme": None, "skills": []}
    if "README.md" in files:
        out["readme"] = files["README.md"].decode(errors="replace")[:DOC_CHARS]
    for rel in sorted(files):
        parts = rel.split("/")
        if len(parts) == 3 and parts[0] == "skills" and parts[2] == "SKILL.md":
            out["skills"].append({"name": parts[1], "content": files[rel].decode(errors="replace")[:DOC_CHARS]})
    return out


@router.get("/plugins/{plugin_id}/files")
def package_files(plugin_id: str, version: str | None = None, include: str = "plugin.yaml", ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """Fetch-and-hash for the browser (todo10 Phase 3): the sha256 of every file in the package
    and the bytes of the `include`d ones (comma-separated paths; the manifest's
    `ui.contributions` is always included). The browser hashes the bytes,
    checks them against `hashes`, and recomputes the tree digest from `hashes`; it must equal
    the digest the workspace pinned. Verified here too, on this load."""
    _need(ctx, "plugins.read")
    e = _visible(ctx, db, plugin_id, version)
    files = _files(ctx, e, "files")
    wanted = [p for p in include.split(",") if p][:16]
    if rel := (e.manifest.get("ui") or {}).get("contributions"):
        wanted.append(str(rel))
    return {
        "id": e.id,
        "version": e.version,
        "artifactDigest": e.artifact_digest,
        "manifestDigest": e.manifest_digest,
        "signer": e.signer_id,
        "hashes": {rel: hashlib.sha256(b).hexdigest() for rel, b in files.items()},
        "files": {p: base64.b64encode(files[p]).decode() for p in wanted if p in files},
    }


@router.get("/plugins/{plugin_id}")
def inspect(plugin_id: str, version: str | None = None, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    _need(ctx, "plugins.read")
    e = _visible(ctx, db, plugin_id, version)
    out = {**e.summary(), "versions": [v.version for v in catalog.versions(plugin_id, db)], "manifest": e.manifest}
    # Declarative UI (ui/contributions.json) travels as data: the web registers it at runtime,
    # so activating a plugin needs no web deploy. The bytes are verified on every load.
    rel = (e.manifest.get("ui") or {}).get("contributions")
    if rel:
        files = _files(ctx, e, "inspect")
        if rel in files:
            out["contributions"] = json.loads(files[rel])
    return out


@router.get("/workspaces/{workspace_id}/plugins")
def installed(workspace_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    c = _ws(ctx, workspace_id, "plugins.read")
    state = installer.workspace_state(db, c)
    out = []
    for p in state["plugins"]:
        m = installer.manifest_of(db, p["pluginId"], p["version"])
        out.append({**p, "name": m.get("name"), "permissions": policy.report(db, c.workspace_id, p["pluginId"], p["version"], m), "config": installer.current_config(db, c.workspace_id, p["pluginId"]), "versions": [v.version for v in catalog.versions(p["pluginId"], db)]})
    return {"plugins": out, "history": installer.history(db, c)}


@router.post("/workspaces/{workspace_id}/plugins/load-refused")
def load_refused(workspace_id: str, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    """The browser refused a plugin's bytes (fetch-and-hash mismatch): record it in the audit log."""
    c = _ws(ctx, workspace_id, "plugins.read")
    pid, version = str(body.get("pluginId") or "")[:256], str(body.get("version") or "")[:64]
    reason = str(body.get("reason") or "")[:300]
    audit.record(db, c, "plugins.artifact.refused", target=f"{pid}@{version}", after={"reason": reason, "where": "browser", "expected": str(body.get("expected") or "")[:80], "got": str(body.get("got") or "")[:80]})
    return {"recorded": True}


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
