"""Command gateway (docs/plugins.md §8.2): the one path from UI, agent, API or workflow to a plugin.

    submit → resolve active plugin + version → validate input → policy (grants, egress,
    secrets) and budget → route (worker job, or the built-in mock) → validate output →
    normalise and commit canonical annotations → audit + event

Nothing reaches plugin code without passing every step, and nothing a plugin returns
reaches the annotation document without validation. Identity and tenancy come from the
request context, never from the command input.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext
from ..models import PluginJob
from ..naming import canonical_id, ns
from ..plugins import installer, policy
from . import annotations, assets, audit, events, jobs
from .contracts import CAPABILITIES, normalize_result
from .providers import mock_segment

BUILTIN = ns("kernel.builtin")


def _resolve(db: Session, ctx: RequestContext, body: dict) -> tuple[str, str, dict, str, str | None]:
    """→ (plugin_id, version, manifest, tool, capability)."""
    tool_id: str | None = body.get("tool")
    capability: str | None = body.get("capability")
    act = installer.active_manifests(db, ctx.workspace_id)
    if tool_id:
        tool_id = canonical_id(tool_id)
        for inst, m in act:
            if tool_id.startswith(inst.plugin_id + "."):
                tool = tool_id[len(inst.plugin_id) + 1 :]
                cap = next((c["id"] for c in m.get("capabilities") or [] if c.get("tool") == tool), None)
                return inst.plugin_id, inst.version, m, tool, cap
        raise HTTPException(403, f"no active plugin in this workspace provides {tool_id}")
    if not capability:
        raise HTTPException(422, "give a `capability` or a full `tool` id")
    providers = [(inst, m, c) for inst, m in act for c in m.get("capabilities") or [] if c["id"] == capability]
    if body.get("plugin"):
        providers = [p for p in providers if p[0].plugin_id == canonical_id(body["plugin"])]
    if providers:
        inst, m, c = providers[0]
        return inst.plugin_id, inst.version, m, c.get("tool") or capability, capability
    if capability == mock_segment.CAPABILITY and settings().builtin_mock_segment:
        return BUILTIN, "1.0.0", mock_segment.MANIFEST, "segment_objects", capability
    raise HTTPException(403, f"no active plugin in this workspace provides {capability}")


def _units(capability: str | None, payload: dict) -> int:
    """Billable units for a call (images for image.segment)."""
    if capability == "image.segment":
        return 1
    return int(payload.get("units") or 1)


def estimate(manifest: dict, provider: dict | None, capability: str | None, payload: dict) -> float:
    pricing = (provider or {}).get("pricing")
    if not pricing:
        return 0.0
    return round(float(pricing["usdPerUnit"]) * _units(capability, payload), 6)


def budget(db: Session, ctx: RequestContext, plugin_id: str, manifest: dict) -> float | None:
    res = manifest.get("resources") or {}
    cfg = installer.current_config(db, ctx.workspace_id, plugin_id)
    limit = cfg.get("budgetUsdPerJob", res.get("defaultBudgetUsdPerJob"))
    cap = res.get("maxBudgetUsdPerJob")
    if limit is None:
        return cap
    return min(limit, cap) if cap is not None else limit


def dispatch(db: Session, ctx: RequestContext, body: dict) -> tuple[int, dict]:
    """Returns (HTTP status, body): 200 with the result for inline runs, 202 with a job for worker runs."""
    plugin_id, version, manifest, tool, capability = _resolve(db, ctx, body)
    raw_input = body.get("input") or {}
    if not isinstance(raw_input, dict):
        raise HTTPException(422, "input must be an object")

    # Input contract.
    payload: dict[str, Any] = raw_input
    if capability and capability in CAPABILITIES:
        try:
            payload = CAPABILITIES[capability].request.model_validate(raw_input).model_dump(mode="json", exclude_none=True)
        except ValidationError as e:
            raise HTTPException(422, {"message": f"input doesn't match {capability}", "errors": e.errors(include_url=False)}) from e
        for p in payload.get("prompts") or []:
            if p.get("type") == "box" and not (p["box"][0] < p["box"][2] and p["box"][1] < p["box"][3]):
                raise HTTPException(422, "box prompts are XYXY pixels with x0 < x1 and y0 < y1")

    # Provider.
    cfg = installer.current_config(db, ctx.workspace_id, plugin_id) if plugin_id != BUILTIN else {}
    provider_id = payload.get("provider") or cfg.get("provider")
    provs = manifest.get("providers") or []
    provider = next((p for p in provs if p["id"] == provider_id), None) if provider_id else (provs[0] if provs else None)
    if provider_id and provider is None:
        raise HTTPException(422, f"{plugin_id} has no provider {provider_id!r}")
    if provider and capability and capability not in provider.get("implements", []):
        raise HTTPException(422, f"provider {provider['id']} doesn't implement {capability}")

    # Policy: everything the plugin needs must be granted for this version in this workspace.
    if plugin_id != BUILTIN:
        needed = list(policy.requested(manifest)["required"]) + (policy.provider_needs(provider) if provider else [])
        missing = policy.missing(db, ctx.workspace_id, plugin_id, version, needed)
        if missing:
            audit.record(db, ctx, "gateway.denied", target=f"{plugin_id}.{tool}", after={"missing": missing})
            raise HTTPException(403, {"message": f"{plugin_id}@{version} lacks granted permissions", "missing": missing})

    # Assets named in the input must exist in *this* workspace.
    asset_id = payload.get("asset_id")
    if asset_id:
        asset = assets.get_asset(db, ctx, asset_id)
        payload.setdefault("item_id", asset.path)

    # Budget: deny before any billable call (§14 #10).
    cost = estimate(manifest, provider, capability, payload)
    limit = budget(db, ctx, plugin_id, manifest)
    if cost > 0 and (limit is None or cost > limit):
        audit.record(db, ctx, "gateway.budget_denied", target=f"{plugin_id}.{tool}", after={"estimateUsd": cost, "budgetUsd": limit, "provider": provider and provider["id"]})
        raise HTTPException(402, {"message": "estimated cost exceeds the budget", "estimateUsd": cost, "budgetUsd": limit, "provider": provider and provider["id"]})

    runtime = (manifest.get("runtime") or {}).get("kind")
    job, created = jobs.enqueue(
        db,
        ctx,
        plugin_id=plugin_id,
        version=version,
        tool=tool if plugin_id != BUILTIN else "__builtin__",
        input={**payload, **({"provider": provider["id"]} if provider else {})},
        capability=capability,
        provider=provider["id"] if provider else None,
        estimated_cost_usd=cost,
        timeout_s=int((manifest.get("runtime") or {}).get("maxExecutionSeconds") or 180),
    )
    audit.record(db, ctx, "gateway.invoke", target=f"{plugin_id}.{tool}", after={"jobId": job.job_id, "capability": capability, "provider": job.provider, "estimateUsd": cost, "replay": not created})
    if not created:
        return 200, {"job": jobs.job_dict(job), "replayed": True}

    if plugin_id == BUILTIN:
        job.state, job.attempts = "running", 1
        finish(db, job, mock_segment.run(job.input, assets.get_asset(db, ctx, job.input["asset_id"])))
        return 200, {"job": jobs.job_dict(job)}
    if runtime != "python-worker":
        job.state, job.error, job.recoverable = "failed", f"{plugin_id} has no executable runtime ({runtime})", False
        return 409, {"job": jobs.job_dict(job)}
    return 202, {"job": jobs.job_dict(job)}


def finish(db: Session, job: PluginJob, raw_result: Any, cost_usd: float | None = None) -> PluginJob:
    """Validate a job's output against its capability, normalise and commit it. Invalid output fails the job, recoverably."""
    ctx = RequestContext(job.workspace_id, f"plugin:{job.plugin_id}@{job.version}", job.correlation_id)
    if job.state == "cancelled":
        return job
    if cost_usd is not None:
        job.cost_usd = float(cost_usd)
    try:
        if job.capability and job.capability in CAPABILITIES:
            result = CAPABILITIES[job.capability].result.model_validate(raw_result).model_dump(mode="json", exclude_none=True)
            anns = normalize_result(job.capability, result, job, author=f"plugin:{job.plugin_id}@{job.version}", db=db)
        else:
            result, anns = raw_result if isinstance(raw_result, dict) else {"value": raw_result}, []
        ids = annotations.commit(db, ctx, anns, idempotency_key=f"job:{job.job_id}", job_id=job.job_id, source=f"{job.plugin_id}.{job.tool}") if anns else []
    except (ValidationError, ValueError) as e:
        job.state, job.recoverable = "failed", True
        job.error = f"invalid {job.capability or 'tool'} output from {job.plugin_id}: {e}"[:4000]
        audit.record(db, ctx, "jobs.invalid_output", target=job.job_id, after={"error": job.error})
        events.publish(db, ctx, "job.failed", {"jobId": job.job_id, "pluginId": job.plugin_id}, source=job.plugin_id, idempotency_key=f"job.failed:{job.job_id}")
        return job
    job.state, job.progress, job.result = "succeeded", 1.0, {**result, "annotationIds": ids}
    if job.plugin_id != BUILTIN:
        for p in policy.requested(installer.manifest_of(db, job.plugin_id, job.version))["required"]:
            policy.record_use(db, job.workspace_id, job.plugin_id, job.version, p, job.job_id)
    audit.record(db, ctx, "jobs.succeeded", target=job.job_id, after={"annotationIds": ids, "costUsd": job.cost_usd})
    events.publish(db, ctx, "job.succeeded", {"jobId": job.job_id, "pluginId": job.plugin_id}, source=job.plugin_id, idempotency_key=f"job.succeeded:{job.job_id}")
    if ids:
        events.publish(db, ctx, "annotations.committed", {"jobId": job.job_id, "annotationIds": ids}, source=job.plugin_id, idempotency_key=f"annotations.committed:{job.job_id}")
    return job
