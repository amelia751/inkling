"""Default plugins (todo25 D3): what every new project starts with.

`API_DEFAULT_PLUGINS` lists plugins with their config and grants. Each one goes through the
same path an approved install does (plan → stage → validate → activate with the grants →
configure), as `system:defaults`, so it is audited, pinned and in the history like any other
install. Grants default to what the configured provider needs (its egress and secrets). A
plugin already installed in the project, in any state, is left alone, so the backfill is
idempotent and never re-enables a plugin someone disabled.

Formats: JSON `[{"pluginId": "<id>", "config": {...}, "grants": [...]}]`, or compact
`<id>[:key=value;key=value], <id>…` (values are strings).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext
from ..kernel import audit
from ..models import WorkspacePlugin
from ..naming import canonical_id
from . import installer, policy

log = logging.getLogger(__name__)

PRINCIPAL = "system:defaults"


@dataclass
class Default:
    plugin_id: str
    config: dict = field(default_factory=dict)
    grants: list[str] | None = None  # None: what the configured provider needs


def parse(raw: str | None) -> list[Default]:
    raw = (raw or "").strip()
    if not raw:
        return []
    if raw.startswith("["):
        items = json.loads(raw)
        return [Default(canonical_id(str(i["pluginId"])), dict(i.get("config") or {}), list(i["grants"]) if i.get("grants") is not None else None) for i in items]
    out: list[Default] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        pid, _, rest = part.partition(":")
        config = {}
        for kv in rest.split(";"):
            if "=" in kv:
                k, v = kv.split("=", 1)
                config[k.strip()] = v.strip()
        out.append(Default(canonical_id(pid.strip()), config))
    return out


def configured() -> list[Default]:
    return parse(settings().default_plugins)


def _grants_for(manifest: dict, d: Default) -> list[str]:
    if d.grants is not None:
        return d.grants
    prov = next((p for p in manifest.get("providers") or [] if p.get("id") == d.config.get("provider")), None)
    return policy.provider_needs(prov) if prov else []


def activate_one(db: Session, workspace_id: str, d: Default, correlation_id: str = "defaults") -> str:
    """Activate one default in one project. Returns `activated`, `present` or `skipped:<why>`."""
    if db.get(WorkspacePlugin, (workspace_id, d.plugin_id)) is not None:
        return "present"
    ctx = RequestContext(workspace_id, PRINCIPAL, correlation_id)
    nested = db.begin_nested()
    try:
        r = installer.plan(db, ctx, d.plugin_id)
        if r.state == "RESOLVED":
            r = installer.stage(db, ctx, r.id)
        if r.state == "STAGED":
            r = installer.validate(db, ctx, r.id)
        if r.state != "AWAITING_APPROVAL":
            why = (r.checks or {}).get("rejected") or (r.plan or {}).get("errors") or r.state
            nested.rollback()
            _skipped(db, ctx, d, why)
            return f"skipped:{r.state}"
        item = next(i for i in r.plan["install"] if i["id"] == d.plugin_id)
        entry = installer.catalog.get(d.plugin_id, item["version"], db)
        manifest = entry.manifest if entry else {}
        grants = _grants_for(manifest, d)
        installer._activate(db, ctx, r, grants)
        audit.record(db, ctx, "plugins.default", target=f"{d.plugin_id}@{r.version}", after={"requestId": r.id, "grants": sorted(grants), "config": d.config})
        if d.config:
            installer.configure(db, ctx, d.plugin_id, d.config)
        nested.commit()
        return "activated"
    except Exception as e:  # noqa: BLE001 — a default that can't install never blocks creating the project
        nested.rollback()
        log.warning("default plugin %s not activated in %s: %s", d.plugin_id, workspace_id, e)
        _skipped(db, ctx, d, str(getattr(e, "detail", e)))
        return "skipped:error"


def _skipped(db: Session, ctx: RequestContext, d: Default, why: object) -> None:
    audit.record(db, ctx, "plugins.default_skipped", target=d.plugin_id, after={"reason": why})


def activate_defaults(db: Session, workspace_id: str, defaults: list[Default] | None = None) -> dict[str, str]:
    return {d.plugin_id: activate_one(db, workspace_id, d) for d in (configured() if defaults is None else defaults)}


def backfill(db: Session, defaults: list[Default] | None = None) -> dict[str, dict[str, str]]:
    """One-off for projects created before a default existed. Idempotent; seed (Samples) projects too."""
    from ..models import ProjectRow

    out: dict[str, dict[str, str]] = {}
    for pid in db.scalars(select(ProjectRow.id).where(ProjectRow.archived.is_(False)).order_by(ProjectRow.id)):
        out[pid] = activate_defaults(db, pid, defaults)
    return out
