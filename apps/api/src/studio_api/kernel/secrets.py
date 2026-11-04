"""Secrets broker (docs/plugins.md §6, §10): encrypted at rest, used only through a proxy.

A plugin never sees a secret's plaintext. Its worker gets a short-lived use token bound to
(workspace, plugin version, secret name, allowed hosts) and calls `proxy`, which injects
the credential into an outbound request to an egress host the workspace granted. The
plaintext never reaches the agent's context, the UI, or the plugin process.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from urllib.parse import urlsplit

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..context import RequestContext
from ..models import Organization, PermissionUse, PluginVersion, ProjectRow, Secret
from . import audit


def _fernet() -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(("secrets:" + settings().secret_key).encode()).digest())
    return Fernet(key)


def put(db: Session, ctx: RequestContext, name: str, value: str) -> None:
    if not name.replace("_", "").isalnum() or not name[:1].isalpha() or name.upper() != name:
        raise HTTPException(422, "secret names are UPPER_SNAKE_CASE")
    row = db.scalar(select(Secret).where(Secret.workspace_id == ctx.workspace_id, Secret.name == name))
    token = _fernet().encrypt(value.encode()).decode()
    if row:
        row.ciphertext = token
    else:
        db.add(Secret(workspace_id=ctx.workspace_id, name=name, ciphertext=token, created_by=ctx.principal))
    audit.record(db, ctx, "secrets.put", target=name)  # never the value


def names(db: Session, ctx: RequestContext) -> list[str]:
    return list(db.scalars(select(Secret.name).where(Secret.workspace_id == ctx.workspace_id).order_by(Secret.name)))


def delete(db: Session, ctx: RequestContext, name: str) -> None:
    row = db.scalar(select(Secret).where(Secret.workspace_id == ctx.workspace_id, Secret.name == name))
    if row:
        db.delete(row)
        audit.record(db, ctx, "secrets.delete", target=name)


def _plaintext(db: Session, workspace_id: str, name: str) -> str:
    row = db.scalar(select(Secret).where(Secret.workspace_id == workspace_id, Secret.name == name))
    if row is None:
        raise HTTPException(404, f"secret {name} is not set in this workspace")
    try:
        return _fernet().decrypt(row.ciphertext.encode()).decode()
    except InvalidToken as e:
        raise HTTPException(500, "secret could not be decrypted") from e


# ---- Studio-managed provider keys (todo25 D4) ------------------------------------------------

# A project secret name → (the setting holding the platform key, the only hosts it may go to).
MANAGED_KEYS: dict[str, tuple[str, frozenset[str]]] = {
    "META_MODEL_API_KEY": ("provider_key_meta", frozenset({"api.meta.ai"})),
}


def org_allows_managed_keys(org: Organization | None) -> bool:
    """An org admin's explicit choice wins; unset means on outside production, off in it."""
    if org is not None and org.managed_provider_keys is not None:
        return bool(org.managed_provider_keys)
    return not settings().production


def _managed_value(db: Session, claims: dict, host: str) -> str | None:
    """The platform key when the project has none of its own and its org allows it; audited."""
    name = claims["name"]
    spec = MANAGED_KEYS.get(name)
    if spec is None or db.scalar(select(Secret.id).where(Secret.workspace_id == claims["ws"], Secret.name == name)) is not None:
        return None
    key = getattr(settings(), spec[0], None)
    if not key or host not in spec[1]:
        return None
    project = db.get(ProjectRow, claims["ws"])
    org = db.get(Organization, project.org_id) if project is not None else None
    ctx = RequestContext(claims["ws"], f"plugin:{claims['plugin']}@{claims['version']}", claims.get("job") or "broker")
    if not org_allows_managed_keys(org):
        audit.record(db, ctx, "secrets.managed_refused", target=name, after={"host": host, "job": claims.get("job"), "orgId": org.id if org else None})
        db.commit()  # the refusal is on the record even though the request fails
        raise HTTPException(403, f"{name} isn't set in this project, and its organization hasn't turned on Studio-managed provider keys. An org admin can turn them on (Organization › Settings), or set the project's own {name}.")
    # No org budget ledger exists yet: the price per unit and the org go on the audit entry.
    pv = db.get(PluginVersion, (claims["plugin"], claims["version"]))
    prov = next((p for p in ((pv.manifest if pv else {}) or {}).get("providers") or [] if name in (p.get("secrets") or [])), None)
    pricing = (prov or {}).get("pricing") or {}
    audit.record(db, ctx, "secrets.managed_use", target=name, after={"host": host, "job": claims.get("job"), "orgId": org.id if org else None, "provider": (prov or {}).get("id"), "unit": pricing.get("unit"), "usdPerUnit": pricing.get("usdPerUnit"), "chargedTo": f"org:{org.id}" if org else None})
    return key


# ---- Use tokens and the proxy ------------------------------------------------------------


def _sign(payload: dict) -> str:
    body = base64.urlsafe_b64encode(json.dumps(payload, sort_keys=True).encode()).decode()
    mac = hmac.new(("broker:" + settings().secret_key).encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{mac}"


def _unsign(token: str) -> dict:
    try:
        body, mac = token.rsplit(".", 1)
    except ValueError as e:
        raise HTTPException(401, "malformed use token") from e
    good = hmac.new(("broker:" + settings().secret_key).encode(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, good):
        raise HTTPException(401, "bad use token")
    payload = json.loads(base64.urlsafe_b64decode(body))
    if payload["exp"] < time.time():
        raise HTTPException(401, "use token expired")
    return payload


def issue_use_token(workspace_id: str, plugin_id: str, version: str, name: str, hosts: list[str], job_id: str | None, ttl_s: int = 300) -> str:
    """Called by the gateway for a job whose plugin version holds `secrets.use:<name>`."""
    return _sign({"ws": workspace_id, "plugin": plugin_id, "version": version, "name": name, "hosts": sorted(hosts), "job": job_id, "exp": int(time.time()) + ttl_s})


def proxy(db: Session, token: str, method: str, url: str, *, headers: dict[str, str] | None = None, body: bytes | None = None, inject: str = "Authorization", scheme: str = "Bearer", transport: httpx.BaseTransport | None = None) -> httpx.Response:
    """Perform one outbound call with the secret injected. Hosts outside the token fail closed."""
    claims = _unsign(token)
    host = urlsplit(url).hostname or ""
    if urlsplit(url).scheme != "https" and not host.endswith(".test"):
        raise HTTPException(403, "the broker only calls https endpoints")
    if host not in claims["hosts"]:
        raise HTTPException(403, f"egress to {host} is not granted for {claims['plugin']}")
    managed = _managed_value(db, claims, host)
    value = managed if managed is not None else _plaintext(db, claims["ws"], claims["name"])
    out = {**(headers or {}), inject: f"{scheme} {value}".strip() if scheme else value}
    db.add(PermissionUse(workspace_id=claims["ws"], plugin_id=claims["plugin"], version=claims["version"], permission=f"secrets.use:{claims['name']}", job_id=claims.get("job")))
    db.add(PermissionUse(workspace_id=claims["ws"], plugin_id=claims["plugin"], version=claims["version"], permission=f"network.egress:{host}", job_id=claims.get("job")))
    # Record the use before the call, and never hold a transaction open across a provider call
    # that can take seconds (todo25: a Studio's batch of parallel jobs would serialise on it).
    db.commit()
    with httpx.Client(timeout=60, transport=transport, follow_redirects=False) as client:
        return client.request(method, url, headers=out, content=body)
