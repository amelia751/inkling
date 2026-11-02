"""Organization API keys (todo9 Phase 8): create, list, revoke, and resolve a Bearer key.

workos mode: WorkOS organization API keys (`api_keys.create_organization_api_key`,
`list_organization_api_keys`, `delete_api_key`, `create_validation`). The key's permissions are
our key scopes; validations are cached 60 s (Redis when configured, else in process) keyed by the
SHA-256 of the value, so a revoked key stops working within 60 s.

dev mode: keys live in `org_api_keys` (only the SHA-256 of the secret and a display prefix);
lookups go to the table every time, so revoking is immediate.

A key acts as principal `apikey:<id>` in its owner organization. Its scopes map to kernel scopes
(`KERNEL_SCOPES`); the context always carries at least `apikey`, so `ctx.scopes` is never empty
and the key is never mistaken for a person. The secret is returned once and never logged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets as pysecrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, TypeVar

import anyio
from fastapi import HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import redis_client
from ..config import settings
from ..context import AUTH_API_KEY, RequestContext, client_ip, ensure_workspace, hash_token, scope_of
from ..models import AuditEvent, OrgApiKey, Organization, User, now
from ..naming import naming
from . import client as wclient
from .permissions import PERMISSIONS

log = logging.getLogger(__name__)
T = TypeVar("T")

PRINCIPAL_PREFIX = "apikey:"
MARKER_SCOPE = "apikey"
CREATED = "api_key.created"
REVOKED = "api_key.revoked"

# Key scopes (packages/contracts/src/accounts.ts API_KEY_SCOPES) → kernel scopes (`ctx.allows`).
KERNEL_SCOPES: dict[str, tuple[str, ...]] = {
    "datasets:read": ("annotations.read", "assets.read", "versioning.read", "versioning.checkout"),
    "annotations:write": ("annotations.read", "annotations.write", "proposals.write", "versioning.read", "versioning.write"),
    "environments:write": ("environments.write",),
    "studio:tools": ("commands.invoke", "events.publish"),
    "admin": ("*",),
}
SCOPES: tuple[str, ...] = tuple(KERNEL_SCOPES)

CACHE_TTL_S = 60.0
LAST_USED_EVERY_S = 60.0
MAX_EXPIRY_DAYS = 3650


def dev_prefix() -> str:
    """`<first three letters of the namespace>_sk_dev_` (e.g. `ink_sk_dev_`)."""
    return f"{naming()['namespace'][:3]}_sk_dev_"


def kernel_scopes(key_scopes: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    out: list[str] = [MARKER_SCOPE]
    for s in key_scopes:
        for k in (s, *KERNEL_SCOPES.get(s, ())):
            if k not in out:
                out.append(k)
    return tuple(out)


def key_permissions(key_scopes: list[str] | tuple[str, ...]) -> tuple[str, ...]:
    """Organization permissions (`ctx.can`): only an `admin` key holds any."""
    return PERMISSIONS if "admin" in key_scopes else ()


def _sync(make: Callable[[], Awaitable[T]]) -> T:
    """Run a WorkOS (async client) call from sync code: on the app's event loop when called from a
    worker thread (sync routes and dependencies), else on a fresh loop."""
    try:
        return anyio.from_thread.run(make)
    except RuntimeError:
        return asyncio.run(make())  # type: ignore[arg-type]


def _iso(d: datetime | None) -> str | None:
    if d is None:
        return None
    return (d if d.tzinfo else d.replace(tzinfo=UTC)).astimezone(UTC).isoformat().replace("+00:00", "Z")


def _display(db: Session, principal: str | None) -> str:
    if not principal:
        return ""
    u = db.get(User, principal)
    if u is None:
        return principal
    name = " ".join(p for p in (u.first_name, u.last_name) if p)
    return name or u.email or principal


# ---- The validation cache and last-used timestamps ---------------------------------------------


def _clock() -> float:
    return time.time()


_local: dict[str, tuple[float, str]] = {}  # cache key → (expires at, value); no Redis configured


def _redis() -> Any | None:
    if not settings().redis_url:
        return None
    try:
        return redis_client.client()
    except Exception:  # noqa: BLE001
        return None


def _cache_get(k: str) -> str | None:
    r = _redis()
    if r is not None:
        try:
            return r.get(k)
        except Exception:  # noqa: BLE001 — fall back to the in-process cache
            pass
    hit = _local.get(k)
    if hit is None:
        return None
    if hit[0] <= _clock():
        _local.pop(k, None)
        return None
    return hit[1]


def _cache_set(k: str, value: str, ttl: float = CACHE_TTL_S) -> None:
    r = _redis()
    if r is not None:
        try:
            r.set(k, value, ex=max(1, int(ttl)))
            return
        except Exception:  # noqa: BLE001
            pass
    if len(_local) > 10_000:
        _local.clear()
    _local[k] = (_clock() + ttl, value)


def _cache_del(*keys: str) -> None:
    r = _redis()
    if r is not None:
        try:
            r.delete(*keys)
        except Exception:  # noqa: BLE001
            pass
    for k in keys:
        _local.pop(k, None)


def _validation_key(digest: str) -> str:
    return redis_client.key("apikey", "validation", digest)


def _by_id_key(key_id: str) -> str:
    return redis_client.key("apikey", "byid", key_id)


def _last_used_key(key_id: str) -> str:
    return redis_client.key("apikey", "lastused", key_id)


def last_used(key_id: str) -> str | None:
    return _cache_get(_last_used_key(key_id))


def forget() -> None:
    """Tests: drop the in-process cache."""
    _local.clear()


# ---- Resolving a Bearer key --------------------------------------------------------------------


@dataclass(frozen=True)
class KeyInfo:
    id: str
    org_id: str  # ours
    scopes: tuple[str, ...]
    name: str = ""


def _lookup_dev(db: Session, token: str) -> KeyInfo | None:
    if not token.startswith(dev_prefix()):
        return None
    row = db.scalar(select(OrgApiKey).where(OrgApiKey.secret_hash == hash_token(token)))
    if row is None or row.revoked_at is not None:
        return None
    t = datetime.now(UTC)
    if row.expires_at is not None and row.expires_at.replace(tzinfo=row.expires_at.tzinfo or UTC) <= t:
        return None
    last = row.last_used_at.replace(tzinfo=row.last_used_at.tzinfo or UTC) if row.last_used_at else None
    if last is None or (t - last).total_seconds() >= LAST_USED_EVERY_S:
        row.last_used_at = t
        db.flush()
    return KeyInfo(row.id, row.org_id, tuple(row.scopes or ()), row.name)


def _transient(e: Exception) -> bool:
    from workos._errors import APIError, WorkOSConnectionError, WorkOSTimeoutError

    if isinstance(e, (WorkOSConnectionError, WorkOSTimeoutError)):
        return True
    return isinstance(e, APIError) and ((e.status_code or 500) >= 500 or e.status_code in (408, 429))


def _validate_workos(token: str) -> dict[str, Any] | None:
    """WorkOS's answer for a key value: {id, workosOrgId, scopes, name} or None."""
    try:
        res = _sync(lambda: wclient.client().api_keys.create_validation(value=token))
    except Exception as e:  # noqa: BLE001
        if _transient(e):
            raise HTTPException(503, "can't check the API key right now; try again") from None
        return None  # 401/422: not a key WorkOS knows
    key = getattr(res, "api_key", None)
    if key is None:
        return None
    owner = key.owner
    workos_org = owner.id if getattr(owner, "type", "organization") == "organization" else getattr(owner, "organization_id", None)
    if not workos_org:
        return None
    return {"id": key.id, "workosOrgId": workos_org, "scopes": list(key.permissions or []), "name": key.name}


def _lookup_workos(db: Session, token: str) -> KeyInfo | None:
    if token.startswith(dev_prefix()) or token.count(".") == 2:  # a dev key or a JWT: not a WorkOS key
        return None
    digest = hash_token(token)
    cached = _cache_get(_validation_key(digest))
    if cached is not None:
        data = json.loads(cached)
    else:
        data = _validate_workos(token)
        _cache_set(_validation_key(digest), json.dumps(data))
        if data is not None:
            _cache_set(_by_id_key(data["id"]), digest)
    if data is None:
        return None
    from .bootstrap import org_for_workos_id

    return KeyInfo(data["id"], org_for_workos_id(db, data["workosOrgId"]), tuple(data["scopes"]), data.get("name") or "")


def resolve(request: Request, db: Session, token: str, correlation: str, idem: str | None) -> RequestContext | None:
    """The context for an organization API key, None when `token` isn't one."""
    info = _lookup_workos(db, token) if settings().workos else _lookup_dev(db, token)
    if info is None:
        return None
    if settings().workos:
        _cache_set(_last_used_key(info.id), _iso(datetime.now(UTC)) or "", ttl=90 * 86400)
    workspace, task = scope_of(db, request.headers.get("X-Workspace-Id") or "default")
    ensure_workspace(db, workspace)
    return RequestContext(
        workspace, f"{PRINCIPAL_PREFIX}{info.id}", correlation, idem, scopes=kernel_scopes(info.scopes), task_id=task,
        org_id=info.org_id, permissions=key_permissions(info.scopes), auth=AUTH_API_KEY,
        client_ip=client_ip(request), user_agent=request.headers.get("User-Agent"),
    )


# ---- Managing keys (routes/api_keys.py) --------------------------------------------------------


def check_scopes(scopes: Any) -> list[str]:
    if not isinstance(scopes, list) or not scopes or not all(isinstance(s, str) for s in scopes):
        raise HTTPException(422, f"scopes: pick at least one of {', '.join(SCOPES)}")
    bad = [s for s in scopes if s not in KERNEL_SCOPES]
    if bad:
        raise HTTPException(422, f"unknown scope {bad[0]!r}; scopes are {', '.join(SCOPES)}")
    return list(dict.fromkeys(scopes))


def check_expiry(days: Any) -> datetime | None:
    if days is None:
        return None
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= MAX_EXPIRY_DAYS:
        raise HTTPException(422, f"expiresInDays is a whole number of days from 1 to {MAX_EXPIRY_DAYS}, or null")
    return datetime.now(UTC) + timedelta(days=days)


def _creators(db: Session, org_id: str, ids: list[str]) -> dict[str, str]:
    """workos mode: who created each key, from our `api_key.created` audit rows."""
    if not ids:
        return {}
    rows = db.execute(select(AuditEvent.target, AuditEvent.actor).where(AuditEvent.org_id == org_id, AuditEvent.action == CREATED, AuditEvent.target.in_(ids)))
    return {t: _display(db, a) for t, a in rows if t}


def _workos_org(db: Session, org_id: str) -> str:
    org = db.get(Organization, org_id)
    if org is None or not org.workos_org_id:
        raise HTTPException(409, "this organization isn't linked to WorkOS yet")
    return org.workos_org_id


def _workos_error(e: Exception) -> HTTPException:
    if _transient(e):
        return HTTPException(503, "WorkOS is unavailable; try again")
    status = getattr(e, "status_code", None) or 502
    text = str(getattr(e, "message", None) or getattr(e, "error_description", None) or type(e).__name__)
    return HTTPException(status if 400 <= status < 500 else 502, text)


def _key_dict(db: Session, row: OrgApiKey) -> dict[str, Any]:
    return {"id": row.id, "name": row.name, "prefix": row.prefix, "createdBy": _display(db, row.created_by), "createdAt": _iso(row.created_at), "expiresAt": _iso(row.expires_at), "lastUsedAt": _iso(row.last_used_at), "scopes": list(row.scopes or [])}


def _workos_dict(key: Any, created_by: str | None) -> dict[str, Any]:
    ours = last_used(key.id)
    theirs = _iso(key.last_used_at)
    return {"id": key.id, "name": key.name, "prefix": key.obfuscated_value, "createdBy": created_by or "", "createdAt": _iso(key.created_at), "expiresAt": _iso(key.expires_at), "lastUsedAt": max(filter(None, (ours, theirs)), default=None), "scopes": list(key.permissions or [])}


def list_keys(db: Session, org_id: str) -> list[dict[str, Any]]:
    if not settings().workos:
        rows = db.scalars(select(OrgApiKey).where(OrgApiKey.org_id == org_id, OrgApiKey.revoked_at.is_(None)).order_by(OrgApiKey.created_at.desc()))
        return [_key_dict(db, r) for r in rows]
    keys = _workos_keys(_workos_org(db, org_id))
    creators = _creators(db, org_id, [k.id for k in keys])
    return [_workos_dict(k, creators.get(k.id)) for k in keys]


def _workos_keys(workos_org: str) -> list[Any]:
    async def run() -> list[Any]:
        page = await wclient.client().api_keys.list_organization_api_keys(workos_org, limit=100)
        return [k async for k in page.auto_paging_iter()]

    try:
        return _sync(run)
    except Exception as e:  # noqa: BLE001
        raise _workos_error(e) from None


def create_key(db: Session, ctx: RequestContext, org_id: str, name: str, scopes: list[str], expires_at: datetime | None) -> tuple[dict[str, Any], str]:
    """(ApiKey, secret). The secret exists only in the response."""
    if not settings().workos:
        secret = dev_prefix() + pysecrets.token_urlsafe(32)
        row = OrgApiKey(id=f"key_{pysecrets.token_hex(13)}", org_id=org_id, name=name, prefix=f"{secret[: len(dev_prefix()) + 4]}…{secret[-4:]}", secret_hash=hash_token(secret), scopes=scopes, created_by=ctx.principal, created_at=now(), expires_at=expires_at)
        db.add(row)
        db.flush()
        return _key_dict(db, row), secret
    workos_org = _workos_org(db, org_id)
    try:
        key = _sync(lambda: wclient.client().api_keys.create_organization_api_key(workos_org, name=name, permissions=scopes, expires_at=_iso(expires_at)))
    except Exception as e:  # noqa: BLE001
        raise _workos_error(e) from None
    return _workos_dict(key, _display(db, ctx.principal)), key.value


def revoke_key(db: Session, org_id: str, key_id: str) -> None:
    """404 unless the key belongs to `org_id`."""
    if not settings().workos:
        row = db.get(OrgApiKey, key_id)
        if row is None or row.org_id != org_id or row.revoked_at is not None:
            raise HTTPException(404, "no such API key")
        row.revoked_at = now()
        db.flush()
        return
    if key_id not in {k.id for k in _workos_keys(_workos_org(db, org_id))}:
        raise HTTPException(404, "no such API key")
    try:
        _sync(lambda: wclient.client().api_keys.delete_api_key(key_id))
    except Exception as e:  # noqa: BLE001
        raise _workos_error(e) from None
    forget_key(key_id)


def forget_key(key_id: str) -> None:
    """Drop a key's cached validation: this replica's (or Redis's) goes now; others expire within
    CACHE_TTL_S. Also called by the event sync on `api_key.revoked` (a dashboard revocation)."""
    digest = _cache_get(_by_id_key(key_id))
    _cache_del(_by_id_key(key_id), *([_validation_key(digest)] if digest else []))
