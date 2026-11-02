"""Token scopes (todo17 D12): what an API key or an outside agent's OAuth token may do.

Scopes follow the operation tiers of the catalogue (packages/contracts/src/operations.ts):

    project:read     read tier (any `project:*` scope implies it)
    project:write    write tier (reversible changes)
    project:trash    trash tier (recoverable deletes)
    project:destroy  destroy tier (purge, empty trash): for an agent always 202 + a person's approval
    rules:propose    propose rule changes (change requests on `rules`)

Old API key scopes map onto them (`LEGACY`), and keep their kernel scopes so existing keys keep
exactly the access they had. A request whose route is in the catalogue needs the tier's scope; for
an OAuth token every other route needs `project:read` (GET) or `project:write`. Missing it is a 403
`insufficient_scope` naming the scope (RFC 6750 §3.1), with `WWW-Authenticate` for step-up.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from functools import lru_cache
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)

READ, WRITE, TRASH, DESTROY, RULES = "project:read", "project:write", "project:trash", "project:destroy", "rules:propose"
SCOPES: tuple[str, ...] = (READ, WRITE, TRASH, DESTROY, RULES)
TIER_SCOPE = {"read": READ, "write": WRITE, "trash": TRASH, "destroy": DESTROY, "rules": RULES}

# Old key scopes (todo9 Phase 8) → the new ones (D12: "old names map to new ones").
LEGACY: dict[str, tuple[str, ...]] = {
    "datasets:read": (READ,),
    "annotations:write": (READ, WRITE),
    "environments:write": (READ, WRITE),
    "studio:tools": (READ, WRITE),
    "admin": SCOPES,
}

_READ_K = ("annotations.read", "assets.read", "versioning.read", "versioning.checkout")
# New scopes → kernel scopes (`RequestContext.allows`), for keys and tokens minted with them.
KERNEL: dict[str, tuple[str, ...]] = {
    READ: _READ_K,
    WRITE: (*_READ_K, "annotations.write", "proposals.write", "versioning.write", "environments.write", "commands.invoke", "events.publish", "project.write"),
    TRASH: ("project.write",),
    DESTROY: (),
    RULES: (),
}


def tier_scopes(scopes: Iterable[str]) -> tuple[str, ...]:
    """The D12 scopes a set of (new or old) scope names grants, in `SCOPES` order."""
    got: set[str] = set()
    for s in scopes:
        if s in KERNEL:
            got.add(s)
        got.update(LEGACY.get(s, ()))
    if got & {WRITE, TRASH, DESTROY}:
        got.add(READ)
    return tuple(s for s in SCOPES if s in got)


def kernel_for(scopes: Iterable[str]) -> tuple[str, ...]:
    out: list[str] = []
    for s in scopes:
        for k in KERNEL.get(s, ()):
            if k not in out:
                out.append(k)
    return tuple(out)


def has(ctx: Any, scope: str) -> bool:
    """Whether a token-scoped caller holds a D12 scope. People and session tokens (the in-house
    assistant, workers) aren't governed by D12 scopes: always True for them."""
    if not governed(ctx):
        return True
    held = set(ctx.scopes)
    return scope in held or "*" in held or (scope == READ and bool(held & {WRITE, TRASH, DESTROY}))


def governed(ctx: Any) -> bool:
    from ..context import AUTH_API_KEY, AUTH_OAUTH

    return getattr(ctx, "auth", None) in (AUTH_API_KEY, AUTH_OAUTH)


class InsufficientScope(Exception):
    def __init__(self, scope: str, message: str | None = None):
        super().__init__(message or f"This needs the '{scope}' scope.")
        self.scope = scope
        self.message = message or f"This needs the '{scope}' scope; sign in again and grant it."


def require(ctx: Any, scope: str, what: str | None = None) -> None:
    if not has(ctx, scope):
        raise InsufficientScope(scope, f"{what or 'This'} needs the '{scope}' scope; sign in again and grant it." if what else None)


def require_tier(ctx: Any, tier: str, what: str | None = None) -> None:
    require(ctx, TIER_SCOPE[tier], what)


# ---- Route → tier, from the operations catalogue (schemas/operations.json) --------------------

TIER_ORDER = {"read": 0, "write": 1, "trash": 2, "destroy": 3, "rules": 1}

# Routes outside the catalogue with a tier that isn't their method's default.
EXTRA_ROUTES: dict[tuple[str, str], str] = {
    ("PUT", "/api/v1/projects/{}/rules"): "rules",
    ("PATCH", "/api/v1/projects/{}/rules"): "rules",
    ("POST", "/api/environments/validate"): "read",
    ("POST", "/api/v1/boundary/annotations/export"): "read",
}


def _norm(path: str) -> str:
    import re

    return re.sub(r"\{[^}]*\}", "{}", path)


@lru_cache(maxsize=1)
def route_tiers() -> dict[tuple[str, str], str]:
    """(METHOD, normalised path) → tier. Several operations on one route (`fs/ops`, `PATCH
    projects/{pid}`) keep the lowest tier; the handler checks the body's (fs trash/purge)."""
    from ..naming import REPO_ROOT

    out: dict[tuple[str, str], str] = {}
    try:
        doc = json.loads((REPO_ROOT / "schemas" / "operations.json").read_text())
    except (OSError, ValueError):
        log.warning("schemas/operations.json not found: token scopes use method defaults only")
        doc = {"operations": []}
    for op in doc.get("operations") or []:
        path = op["path"] if op["path"].startswith("/api/") else "/api/v1" + op["path"]
        key = (op["method"].upper(), _norm(path))
        if key not in out or TIER_ORDER[op["tier"]] < TIER_ORDER[out[key]]:
            out[key] = op["tier"]
    out.update({(m, _norm(p)): t for (m, p), t in EXTRA_ROUTES.items()})
    return out


def route_tier(method: str, path: str | None, *, default_by_method: bool) -> str | None:
    if path is None:
        return None
    t = route_tiers().get((method.upper(), _norm(path)))
    if t is not None or not default_by_method:
        return t
    return "read" if method.upper() in ("GET", "HEAD", "OPTIONS") else "write"


def check_route(request: Request, ctx: Any) -> None:
    """For API keys (catalogue routes) and OAuth tokens (every route): the route's tier scope."""
    from ..context import AUTH_OAUTH

    if not governed(ctx):
        return
    route = request.scope.get("route")
    tier = route_tier(request.method, getattr(route, "path", None), default_by_method=ctx.auth == AUTH_OAUTH)
    if tier is not None:
        require_tier(ctx, tier)


# ---- The 403 ----------------------------------------------------------------------------------


def www_authenticate(error: str, *, scope: str | None = None, description: str | None = None) -> str:
    from ..config import settings

    parts = [f'error="{error}"']
    if description:
        parts.append(f'error_description="{description}"')
    if scope:
        parts.append(f'scope="{scope}"')
    if meta := resource_metadata_url(settings()):
        parts.append(f'resource_metadata="{meta}"')
    return "Bearer " + ", ".join(parts)


def resource_metadata_url(s: Any) -> str | None:
    aud = getattr(s, "oauth_audience", None)
    return f"{aud.rstrip('/')}/.well-known/oauth-protected-resource" if aud and aud.startswith("http") else None


def insufficient_scope_response(e: InsufficientScope) -> JSONResponse:
    return JSONResponse(
        {"error": "insufficient_scope", "scope": e.scope, "detail": e.message, "status": 403},
        status_code=403,
        headers={"WWW-Authenticate": www_authenticate("insufficient_scope", scope=e.scope)},
    )


def install(app: Any) -> None:
    async def _h(_req: Any, exc: InsufficientScope) -> JSONResponse:
        return insufficient_scope_response(exc)

    app.add_exception_handler(InsufficientScope, _h)
