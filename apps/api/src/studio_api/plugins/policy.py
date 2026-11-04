"""Permission policy (docs/plugins.md §10.1): requested, granted and used stay distinct.

A manifest *requests* permissions; nothing is usable until a workspace admin *grants* it
for that plugin version (grants don't carry over to a new version); the gateway and the
secrets broker record each *use*.
"""

from __future__ import annotations

import re

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..context import RequestContext
from ..models import PermissionUse, WorkspacePluginGrant


def requested(manifest: dict) -> dict[str, list[str]]:
    p = manifest.get("permissions") or {}
    return {"required": list(p.get("required") or []), "optional": list(p.get("optional") or [])}


def granted(db: Session, workspace_id: str, plugin_id: str, version: str) -> set[str]:
    return set(db.scalars(select(WorkspacePluginGrant.permission).where(WorkspacePluginGrant.workspace_id == workspace_id, WorkspacePluginGrant.plugin_id == plugin_id, WorkspacePluginGrant.version == version)))


def grant(db: Session, ctx: RequestContext, plugin_id: str, version: str, permissions: list[str]) -> None:
    have = granted(db, ctx.workspace_id, plugin_id, version)
    for p in permissions:
        if p not in have:
            db.add(WorkspacePluginGrant(workspace_id=ctx.workspace_id, plugin_id=plugin_id, version=version, permission=p, granted_by=ctx.principal))
    db.flush()


def revoke_all(db: Session, workspace_id: str, plugin_id: str, version: str) -> None:
    db.execute(delete(WorkspacePluginGrant).where(WorkspacePluginGrant.workspace_id == workspace_id, WorkspacePluginGrant.plugin_id == plugin_id, WorkspacePluginGrant.version == version))


def missing(db: Session, workspace_id: str, plugin_id: str, version: str, needed: list[str]) -> list[str]:
    have = granted(db, workspace_id, plugin_id, version)
    return [p for p in needed if p not in have]


def record_use(db: Session, workspace_id: str, plugin_id: str, version: str, permission: str, job_id: str | None = None) -> None:
    db.add(PermissionUse(workspace_id=workspace_id, plugin_id=plugin_id, version=version, permission=permission, job_id=job_id))


def report(db: Session, workspace_id: str, plugin_id: str, version: str, manifest: dict) -> dict:
    used = sorted(set(db.scalars(select(PermissionUse.permission).where(PermissionUse.workspace_id == workspace_id, PermissionUse.plugin_id == plugin_id, PermissionUse.version == version))))
    return {"requested": requested(manifest), "granted": sorted(granted(db, workspace_id, plugin_id, version)), "used": used}


def egress_hosts(perms: set[str] | list[str]) -> list[str]:
    return sorted(p.split(":", 1)[1] for p in perms if p.startswith("network.egress:"))


def provider_needs(provider: dict) -> list[str]:
    """Permissions a provider needs at call time: its egress hosts and secrets."""
    return [f"network.egress:{h}" for h in provider.get("egress") or []] + [f"secrets.use:{s}" for s in provider.get("secrets") or []]


# todo25 W7: model licences that restrict use to research / non-commercial work. Matched on the
# provider's free-text `modelLicense`; such a provider can be selected only in a research org.
_RESTRICTED = re.compile(r"\bCC[- ]BY[- ](?:[A-Z]+-)*NC\b|non[- ]?commercial|research|education(?:al)? use only|academic use only", re.IGNORECASE)


def licence_restricted(model_license: str | None) -> bool:
    """True when the weights' licence is non-commercial or research-only."""
    return bool(model_license) and bool(_RESTRICTED.search(model_license))
