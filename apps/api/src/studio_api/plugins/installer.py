"""Workspace install manager (docs/plugins.md §7.2).

    REQUESTED → RESOLVED → STAGED → VALIDATED → AWAITING_APPROVAL → ACTIVATED | REJECTED
                                                                  ACTIVATED → DISABLED | ROLLED_BACK

Activation atomically pins {plugin_id, version, artifact_digest, config_revision} for one
workspace, in the request's transaction. Rollback restores the previous pin and never
touches annotations. Every transition is audited and kept in the append-only history.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..kernel import audit, events
from ..models import InstallRequest, PluginCapability, PluginPackage, PluginVersion, WorkspaceEnvironment, WorkspacePlugin, WorkspacePluginConfig, WorkspacePluginHistory
from ..naming import canonical_id
from studio_signing import oci

from . import catalog, policy, resolver

ACTIVE = "ACTIVATED"


# ---- Reading workspace state ---------------------------------------------------------------


def installations(db: Session, workspace_id: str) -> list[WorkspacePlugin]:
    return list(db.scalars(select(WorkspacePlugin).where(WorkspacePlugin.workspace_id == workspace_id).order_by(WorkspacePlugin.plugin_id)))


def active(db: Session, workspace_id: str) -> dict[str, WorkspacePlugin]:
    return {r.plugin_id: r for r in installations(db, workspace_id) if r.state == ACTIVE}


def manifest_of(db: Session, plugin_id: str, version: str) -> dict:
    row = db.get(PluginVersion, (plugin_id, version))
    if row is not None:
        return row.manifest
    e = catalog.get(plugin_id, version, db)
    return e.manifest if e and e.version == version else {}


def active_manifests(db: Session, workspace_id: str) -> list[tuple[WorkspacePlugin, dict]]:
    return [(r, manifest_of(db, r.plugin_id, r.version)) for r in active(db, workspace_id).values()]


def _seed_workspace(workspace_id: str) -> dict | None:
    """seed-data/<workspace>/workspace.json, through the BlobStore."""
    from .. import blobstore

    try:
        return json.loads(blobstore.assets().read(f"{workspace_id}/workspace.json"))
    except blobstore.BlobNotFound:
        return None


def bootstrap(db: Session, ctx: RequestContext) -> None:
    """A new workspace starts with the first-party UI plugins (or seed-data/<ws>/workspace.json's list),
    and every workspace has the default plugins (`defaults.ensure`)."""
    from . import defaults

    if not installations(db, ctx.workspace_id):
        _pin_first_party(db, ctx)
    if ctx.principal != defaults.PRINCIPAL:
        defaults.ensure(db, ctx.workspace_id)


def _pin_first_party(db: Session, ctx: RequestContext) -> None:
    wanted: list[str] | None = None
    from ..kernel.projects import template_of

    # A sample copy installs what its template lists (todo14 D2).
    raw = _seed_workspace(template_of(db, ctx.workspace_id))
    if raw is not None:
        wanted = [canonical_id(p["pluginId"] if isinstance(p, dict) else p) for p in raw.get("plugins", [])]
    boot = RequestContext(ctx.workspace_id, "system:bootstrap", ctx.correlation_id)
    for e in catalog.entries(db):
        if e.trust_tier != "first-party" or e.runtime != "browser-bundled":
            continue
        if wanted is not None and e.id not in wanted:
            continue
        latest = catalog.get(e.id, db=db)
        if latest is None or (latest.version, latest.artifact_digest) != (e.version, e.artifact_digest):
            continue  # latest version only
        _register_version(db, e)
        _pin(db, boot, e.id, e.version, e.artifact_digest, 0, ACTIVE)
    db.flush()


def workspace_state(db: Session, ctx: RequestContext) -> dict:
    bootstrap(db, ctx)
    env = db.get(WorkspaceEnvironment, (ctx.workspace_id, ctx.task))
    out = {
        "workspaceId": ctx.workspace_id,
        "plugins": [{"pluginId": r.plugin_id, "version": r.version, "artifactDigest": r.artifact_digest, "configRevision": r.config_revision, "state": r.state} for r in installations(db, ctx.workspace_id)],
    }
    if env and env.environment is not None:
        out["environment"] = env.environment
    return out


def current_config(db: Session, workspace_id: str, plugin_id: str) -> dict:
    row = db.get(WorkspacePlugin, (workspace_id, plugin_id))
    if row is None:
        return {}
    cfg = db.get(WorkspacePluginConfig, (workspace_id, plugin_id, row.config_revision))
    return dict(cfg.config_json) if cfg else {}


# ---- Planning --------------------------------------------------------------------------------


def _contributions(e: catalog.Entry) -> dict:
    rel = (e.manifest.get("ui") or {}).get("contributions")
    if not rel:
        return {}
    try:
        files = catalog.load_files(e)
    except oci.ArtifactRefused:
        return {}  # stage refuses it with the reason
    return json.loads(files[rel]) if rel in files else {}


def _plan_doc(db: Session, ctx: RequestContext, res: resolver.Resolution, target: str) -> dict:
    items = []
    risk = "low"
    for e in res.install:
        perms = policy.requested(e.manifest)
        have = policy.granted(db, ctx.workspace_id, e.id, e.version)
        providers = e.manifest.get("providers") or []
        ui = _contributions(e)
        seen_before = db.scalar(select(WorkspacePluginHistory.id).where(WorkspacePluginHistory.workspace_id == ctx.workspace_id, WorkspacePluginHistory.plugin_id == e.id, WorkspacePluginHistory.version == e.version, WorkspacePluginHistory.state == ACTIVE).limit(1))
        new_perms = [p for p in perms["required"] if p not in have]
        if e.trust_tier != "first-party" or new_perms or (not seen_before and e.runtime != "browser-bundled"):
            risk = "high"
        items.append(
            {
                "id": e.id,
                "version": e.version,
                "artifactDigest": e.artifact_digest,
                "trustTier": e.trust_tier,
                "runtime": e.runtime,
                "newCode": not seen_before,
                "modules": [e.id],
                "permissions": {"required": perms["required"], "optional": perms["optional"], "alreadyGranted": sorted(have)},
                "secrets": sorted({s for p in providers for s in p.get("secrets") or []}),
                "egress": sorted({h for p in providers for h in p.get("egress") or []}),
                "providers": [{"id": p["id"], "hosting": p.get("hosting"), "pricing": p.get("pricing"), "modelLicense": p.get("modelLicense"), "serviceTerms": p.get("serviceTerms"), "researchOnly": policy.licence_restricted(p.get("modelLicense")), "quality": p.get("quality")} for p in providers],
                "estimatedSpend": {"defaultBudgetUsdPerJob": (e.manifest.get("resources") or {}).get("defaultBudgetUsdPerJob"), "maxBudgetUsdPerJob": (e.manifest.get("resources") or {}).get("maxBudgetUsdPerJob")},
                "dataResidency": sorted({p.get("hosting") or "unknown" for p in providers}) or ["in-workspace"],
                "uiSurfaces": sorted({a.get("surface") for a in ui.get("toolbarActions", [])} | {p.get("surface") for p in ui.get("panels", [])}),
                "licenses": e.licenses or {"code": e.manifest.get("license")},
                # Agent-authored code: the reviewer sees exactly what changed (§9).
                **({"codeDiff": e.review} if e.stored and e.review else {}),
                **({"manifestDigest": e.manifest_digest, "signer": e.signer_id} if e.stored else {}),
            }
        )
    return {"target": target, "install": items, "errors": res.errors, "conflicts": res.conflicts, "risk": risk}


def plan(db: Session, ctx: RequestContext, plugin_id: str, version: str | None = None) -> InstallRequest:
    bootstrap(db, ctx)
    pid = canonical_id(plugin_id)
    res = resolver.resolve(pid, version, {k: v.version for k, v in active(db, ctx.workspace_id).items()}, db)
    for e in res.install:
        if not catalog.visible(db, e, ctx.workspace_id):
            res.errors.append({"code": "not_found", "message": f"{e.id}@{e.version} isn't available in this workspace"})
    doc = _plan_doc(db, ctx, res, pid)
    target = next((e for e in res.install if e.id == pid), None)
    req = InstallRequest(workspace_id=ctx.workspace_id, plugin_id=pid, version=target.version if target else (version or "?"), state="RESOLVED" if res.ok else "REJECTED", plan=doc, requested_by=ctx.principal)
    db.add(req)
    db.flush()
    audit.record(db, ctx, "plugins.plan", target=f"{pid}@{req.version}", after={"requestId": req.id, "state": req.state, "risk": doc["risk"], "errors": res.errors, "conflicts": res.conflicts})
    return req


def get_request(db: Session, ctx: RequestContext, request_id: str) -> InstallRequest:
    r = db.get(InstallRequest, request_id)
    if r is None or r.workspace_id != ctx.workspace_id:
        raise HTTPException(404, "no such install request in this workspace")
    return r


def _expect(r: InstallRequest, *states: str) -> None:
    if r.state not in states:
        raise HTTPException(409, f"install request is {r.state}; expected {' or '.join(states)}")


def _reject(db: Session, ctx: RequestContext, r: InstallRequest, why: list[str]) -> InstallRequest:
    r.state = "REJECTED"
    r.checks = {**(r.checks or {}), "rejected": why}
    audit.record(db, ctx, "plugins.reject", target=f"{r.plugin_id}@{r.version}", after={"requestId": r.id, "reasons": why})
    return r


def stage(db: Session, ctx: RequestContext, request_id: str) -> InstallRequest:
    """Verify every artifact against its registry digest and lockfile before anything runs."""
    r = get_request(db, ctx, request_id)
    _expect(r, "RESOLVED")
    problems: list[str] = []
    for item in r.plan["install"]:
        e = catalog.get(item["id"], item["version"], db)
        if e is None:
            problems.append(f"{item['id']}@{item['version']}: package not found in the registry store")
            continue
        if item.get("artifactDigest") and item["artifactDigest"] != e.artifact_digest:
            problems.append(f"{e.id}@{e.version}: the registry's digest changed since the plan ({item['artifactDigest']} → {e.artifact_digest})")
        if e.stored and not catalog.visible(db, e, ctx.workspace_id):
            problems.append(f"{e.id}: generated in another workspace")
            continue
        # Digest, signature, signed plugin.yaml and attestation, from the bytes up (todo10 Phase 3).
        try:
            files = catalog.load_files(e)
        except oci.ArtifactRefused as x:
            problems.append(f"{e.id}@{e.version}: {x}")
            audit.record(db, ctx, "plugins.artifact.refused", target=f"{e.id}@{e.version}", after={"reason": str(x), "where": "stage", "manifestDigest": e.manifest_digest, "requestId": r.id})
            continue
        if e.runtime == "python-worker" and "uv.lock" not in files:
            problems.append(f"{e.id}: python-worker plugins must ship uv.lock")
    if problems:
        return _reject(db, ctx, r, problems)
    r.state = "STAGED"
    audit.record(db, ctx, "plugins.stage", target=f"{r.plugin_id}@{r.version}", after={"requestId": r.id})
    return r


def validate(db: Session, ctx: RequestContext, request_id: str) -> InstallRequest:
    """Schema, permission and licence checks; then the request waits for approval."""
    from ..kernel.contracts import validate_plugin_manifest

    r = get_request(db, ctx, request_id)
    _expect(r, "STAGED")
    problems: list[str] = []
    checks: dict = {}
    for item in r.plan["install"]:
        e = catalog.get(item["id"], item["version"], db)
        assert e is not None
        errs = validate_plugin_manifest(e.manifest)
        checks[e.id] = {"manifest": "ok" if not errs else errs}
        problems += [f"{e.id}: {x}" for x in errs]
        unpriced = [p["id"] for p in e.manifest.get("providers") or [] if p.get("hosting") == "hosted" and not p.get("pricing")]
        if unpriced:
            # Not a rejection: the gateway refuses billable calls to these until pricing is published.
            checks[e.id]["unpricedHostedProviders"] = unpriced
        if e.trust_tier == "generated" and (e.manifest.get("ui") or {}).get("module"):
            problems.append(f"{e.id}: generated plugins may only use declarative UI (ui.contributions)")
    r.checks = {**(r.checks or {}), **checks}
    if problems:
        return _reject(db, ctx, r, problems)
    r.state = "AWAITING_APPROVAL"
    audit.record(db, ctx, "plugins.validate", target=f"{r.plugin_id}@{r.version}", after={"requestId": r.id})
    return r


def _register_version(db: Session, e: catalog.Entry) -> None:
    if db.get(PluginPackage, e.id) is None:
        db.add(PluginPackage(id=e.id, publisher=e.publisher, license=e.manifest.get("license", ""), trust_tier=e.trust_tier))
    if db.get(PluginVersion, (e.id, e.version)) is None:
        db.add(PluginVersion(plugin_id=e.id, version=e.version, artifact_digest=e.artifact_digest, manifest=e.manifest, signature=json.dumps(e.signature) if e.signature else None))
        for c in e.capabilities:
            db.add(PluginCapability(plugin_id=e.id, version=e.version, capability_id=c["id"], schema_ref=c.get("outputSchema")))
    db.flush()


def _pin(db: Session, ctx: RequestContext, plugin_id: str, version: str, artifact_digest: str | None, config_revision: int, state: str) -> WorkspacePlugin:
    row = db.get(WorkspacePlugin, (ctx.workspace_id, plugin_id))
    before = {"version": row.version, "state": row.state, "configRevision": row.config_revision} if row else None
    if row is None:
        row = WorkspacePlugin(workspace_id=ctx.workspace_id, plugin_id=plugin_id, version=version, artifact_digest=artifact_digest, config_revision=config_revision, state=state)
        db.add(row)
    else:
        row.version, row.artifact_digest, row.config_revision, row.state = version, artifact_digest, config_revision, state
    db.add(WorkspacePluginHistory(workspace_id=ctx.workspace_id, plugin_id=plugin_id, version=version, artifact_digest=artifact_digest, config_revision=config_revision, state=state, actor=ctx.principal))
    audit.record(db, ctx, f"plugins.{state.lower()}", target=f"{plugin_id}@{version}", before=before, after={"version": version, "state": state, "configRevision": config_revision, "artifactDigest": artifact_digest})
    db.flush()
    return row


def _activate(db: Session, ctx: RequestContext, r: InstallRequest, optional_grants: list[str]) -> InstallRequest:
    for item in r.plan["install"]:
        e = catalog.get(item["id"], item["version"], db)
        assert e is not None
        req = policy.requested(e.manifest)
        extra = [p for p in optional_grants if p in req["optional"]] if e.id == r.plugin_id else []
        _register_version(db, e)
        policy.grant(db, ctx, e.id, e.version, req["required"] + extra)
        prev = db.get(WorkspacePlugin, (ctx.workspace_id, e.id))
        _pin(db, ctx, e.id, e.version, e.artifact_digest, prev.config_revision if prev else 0, ACTIVE)
        events.publish(db, ctx, "plugin.activated", {"pluginId": e.id, "version": e.version}, source="kernel:installer")
    r.state = ACTIVE
    r.approved_by = ctx.principal
    return r


def approve(db: Session, ctx: RequestContext, request_id: str, optional_grants: list[str] | None = None) -> InstallRequest:
    """User/admin approval of the plan's diff; activates in this workspace only."""
    if not ctx.allows("plugins.approve"):
        raise HTTPException(403, "this session can't approve installs")
    r = get_request(db, ctx, request_id)
    _expect(r, "AWAITING_APPROVAL")
    return _activate(db, ctx, r, optional_grants or [])


def activate(db: Session, ctx: RequestContext, request_id: str) -> InstallRequest:
    """Streamlined path (§7.2): only for low-risk plans (first-party, nothing new to grant or run)."""
    r = get_request(db, ctx, request_id)
    _expect(r, "AWAITING_APPROVAL", "ACTIVATED")
    if r.state == ACTIVE:
        return r
    if r.plan.get("risk") != "low":
        raise HTTPException(409, "this change installs new code or permissions; it needs approval (POST …/approve)")
    return _activate(db, ctx, r, [])


def reject(db: Session, ctx: RequestContext, request_id: str, reason: str = "rejected by user") -> InstallRequest:
    r = get_request(db, ctx, request_id)
    _expect(r, "RESOLVED", "STAGED", "VALIDATED", "AWAITING_APPROVAL")
    return _reject(db, ctx, r, [reason])


def disable(db: Session, ctx: RequestContext, plugin_id: str) -> WorkspacePlugin:
    pid = canonical_id(plugin_id)
    row = db.get(WorkspacePlugin, (ctx.workspace_id, pid))
    if row is None or row.state != ACTIVE:
        raise HTTPException(404, f"{pid} is not active in this workspace")
    dependents = [m for r, m in active_manifests(db, ctx.workspace_id) if r.plugin_id != pid and pid in {canonical_id(k) for k in (m.get("requires") or {})}]
    if dependents:
        raise HTTPException(409, {"message": f"{pid} is required by active plugins; disable them first", "dependents": [d.get("id") for d in dependents]})
    row = _pin(db, ctx, pid, row.version, row.artifact_digest, row.config_revision, "DISABLED")
    events.publish(db, ctx, "plugin.disabled", {"pluginId": pid, "version": row.version}, source="kernel:installer")
    return row


def rollback(db: Session, ctx: RequestContext, plugin_id: str) -> WorkspacePlugin:
    """Restore the previous ACTIVATED pin (version, digest, config). Annotations are never touched."""
    pid = canonical_id(plugin_id)
    row = db.get(WorkspacePlugin, (ctx.workspace_id, pid))
    if row is None:
        raise HTTPException(404, f"{pid} was never installed in this workspace")
    current = (row.version, row.artifact_digest, row.config_revision)
    hist = db.scalars(select(WorkspacePluginHistory).where(WorkspacePluginHistory.workspace_id == ctx.workspace_id, WorkspacePluginHistory.plugin_id == pid, WorkspacePluginHistory.state == ACTIVE).order_by(WorkspacePluginHistory.id.desc())).all()
    prev = next((h for h in hist if (h.version, h.artifact_digest, h.config_revision) != current), None)
    db.add(WorkspacePluginHistory(workspace_id=ctx.workspace_id, plugin_id=pid, version=row.version, artifact_digest=row.artifact_digest, config_revision=row.config_revision, state="ROLLED_BACK", actor=ctx.principal))
    if prev is None:
        return disable(db, ctx, pid) if row.state == ACTIVE else row
    return _pin(db, ctx, pid, prev.version, prev.artifact_digest, prev.config_revision, ACTIVE)


def _check_licence(db: Session, ctx: RequestContext, provider: dict) -> None:
    """todo25 W7: research-only or non-commercial weights only in an org marked research."""
    if not policy.licence_restricted(provider.get("modelLicense")):
        return
    from ..models import Organization

    org_id = catalog.org_of(db, ctx.workspace_id)
    org = db.get(Organization, org_id) if org_id else None
    if org is None or not org.research:
        raise HTTPException(403, {"message": f"provider {provider['id']!r} uses weights licensed for research or non-commercial use only ({provider.get('modelLicense')}); an org admin must mark the organization as research (Organization › Settings) before it can be selected", "code": "provider_licence_research_only"})


def configure(db: Session, ctx: RequestContext, plugin_id: str, config: dict) -> dict:
    """New config revision. Switching provider is a streamlined change only if its egress/secrets are already granted."""
    pid = canonical_id(plugin_id)
    row = db.get(WorkspacePlugin, (ctx.workspace_id, pid))
    if row is None or row.state != ACTIVE:
        raise HTTPException(404, f"{pid} is not active in this workspace")
    manifest = manifest_of(db, pid, row.version)
    if "provider" in config:
        prov = next((p for p in manifest.get("providers") or [] if p["id"] == config["provider"]), None)
        if prov is None:
            raise HTTPException(422, f"{pid}@{row.version} has no provider {config['provider']!r}")
        _check_licence(db, ctx, prov)
        missing = policy.missing(db, ctx.workspace_id, pid, row.version, policy.provider_needs(prov))
        if missing:
            requested = set(policy.requested(manifest)["optional"]) | set(policy.requested(manifest)["required"])
            raise HTTPException(409, {"message": "this provider needs permissions the workspace hasn't granted; approve them first", "missing": missing, "requestable": [m for m in missing if m in requested]})
    for k in ("budgetUsdPerJob",):
        if k in config and (not isinstance(config[k], (int, float)) or config[k] < 0):
            raise HTTPException(422, f"{k} must be a non-negative number")
    before = current_config(db, ctx.workspace_id, pid)
    # After a rollback the pinned revision isn't the newest one: never reuse a revision number.
    latest = db.scalar(select(func.max(WorkspacePluginConfig.config_revision)).where(WorkspacePluginConfig.workspace_id == ctx.workspace_id, WorkspacePluginConfig.plugin_id == pid))
    rev = max(row.config_revision, latest or 0) + 1
    db.add(WorkspacePluginConfig(workspace_id=ctx.workspace_id, plugin_id=pid, config_revision=rev, config_json={**before, **config}, secret_refs=[], created_by=ctx.principal))
    db.flush()
    _pin(db, ctx, pid, row.version, row.artifact_digest, rev, ACTIVE)
    return {"pluginId": pid, "configRevision": rev, "config": {**before, **config}}


def grant_permissions(db: Session, ctx: RequestContext, plugin_id: str, permissions: list[str]) -> list[str]:
    """Approve additional requested permissions for the active version (e.g. a provider's egress)."""
    if not ctx.allows("plugins.approve"):
        raise HTTPException(403, "this session can't grant permissions")
    pid = canonical_id(plugin_id)
    row = db.get(WorkspacePlugin, (ctx.workspace_id, pid))
    if row is None or row.state != ACTIVE:
        raise HTTPException(404, f"{pid} is not active in this workspace")
    req = policy.requested(manifest_of(db, pid, row.version))
    allowed = set(req["required"]) | set(req["optional"])
    bad = [p for p in permissions if p not in allowed]
    if bad:
        raise HTTPException(422, {"message": "only requested permissions can be granted", "notRequested": bad})
    policy.grant(db, ctx, pid, row.version, permissions)
    audit.record(db, ctx, "plugins.grant", target=f"{pid}@{row.version}", after={"permissions": permissions})
    return sorted(policy.granted(db, ctx.workspace_id, pid, row.version))


def history(db: Session, ctx: RequestContext, plugin_id: str | None = None) -> list[dict]:
    q = select(WorkspacePluginHistory).where(WorkspacePluginHistory.workspace_id == ctx.workspace_id)
    if plugin_id:
        q = q.where(WorkspacePluginHistory.plugin_id == canonical_id(plugin_id))
    return [{"pluginId": h.plugin_id, "version": h.version, "state": h.state, "configRevision": h.config_revision, "actor": h.actor, "at": h.at.isoformat()} for h in db.scalars(q.order_by(WorkspacePluginHistory.id))]


def request_dict(r: InstallRequest) -> dict:
    return {"requestId": r.id, "pluginId": r.plugin_id, "version": r.version, "state": r.state, "plan": r.plan, "checks": r.checks, "requestedBy": r.requested_by, "approvedBy": r.approved_by}


def package_path(e: catalog.Entry) -> Path | None:
    return catalog.package_dir(e)
