"""Organization › Security (todo9 Phase 9).

    GET   /api/v1/org/security              → OrgSecurity
    PATCH /api/v1/org/security {mfaRequired} (org:manage) → 409: see below
    POST  /api/v1/org/admin-portal {intent}  (org:manage) → {url}: a 5 min Admin Portal link

MFA: WorkOS 10.x (Python SDK and REST reference) has no API for an organization's MFA policy;
it's set in the dashboard (Authentication › Multi-factor auth, or the organization's policies).
So `mfaEditable` is false and the PATCH answers 409 with the reason; `mfaRequired` reports false.
Sign-in methods and the session length are environment-wide in WorkOS and can't be read through
the API either: they come from settings (`API_SIGNIN_METHODS`, `API_SESSION_MAX_HOURS`).

SSO, directory and domains come from WorkOS (`list_connections`, `list_directories`, the
organization's `domains`), cached 60 s (Redis when configured, else per process: only a cache).
dev mode answers offline: nothing configured, and the Admin Portal link is a fake URL on the
configured WorkOS base so e2e can assert it.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import audit, current_org
from ..auth import client as wclient
from ..auth.permissions import ORG_MANAGE, require_permission
from ..config import settings
from ..context import RequestContext, get_context
from ..db import get_session
from ..models import Organization

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1")

ADMIN_PORTAL_OPENED = "security.admin_portal_opened"
INTENTS = ("sso", "dsync", "domain_verification", "audit_logs", "log_streams")
# AuthKit sign-in methods, in the order the page lists them.
METHODS: tuple[tuple[str, str], ...] = (
    ("password", "Email and password"),
    ("google", "Google"),
    ("microsoft", "Microsoft"),
    ("github", "GitHub"),
    ("apple", "Apple"),
    ("magic_auth", "Magic link"),
    ("passkey", "Passkeys"),
)
MFA_NOT_EDITABLE = "the MFA policy is set in the WorkOS dashboard; WorkOS has no API to change an organization's MFA policy"
STATUS_TTL_S = 60


# ---- A 60 s cache of the WorkOS status (Redis if configured, else this process) ------------------

_local: dict[str, tuple[float, dict[str, Any]]] = {}


def _cache_get(key: str) -> dict[str, Any] | None:
    if settings().redis_url:
        try:
            from .. import redis_client

            raw = redis_client.client().get(redis_client.key("workos", "org-security", key))
            return json.loads(raw) if raw else None
        except Exception:  # noqa: BLE001 — a cache miss, never an error
            log.debug("security status cache read failed", exc_info=True)
            return None
    hit = _local.get(key)
    return hit[1] if hit and time.monotonic() - hit[0] < STATUS_TTL_S else None


def _cache_put(key: str, value: dict[str, Any]) -> None:
    if settings().redis_url:
        try:
            from .. import redis_client

            redis_client.client().set(redis_client.key("workos", "org-security", key), json.dumps(value), ex=STATUS_TTL_S)
        except Exception:  # noqa: BLE001
            log.debug("security status cache write failed", exc_info=True)
        return
    _local[key] = (time.monotonic(), value)


def forget_status(workos_org_id: str | None = None) -> None:
    """Drop the cached status (after an Admin Portal change is reported by events, and in tests)."""
    if workos_org_id is None:
        _local.clear()
    else:
        _local.pop(workos_org_id, None)
        if settings().redis_url:
            try:
                from .. import redis_client

                redis_client.client().delete(redis_client.key("workos", "org-security", workos_org_id))
            except Exception:  # noqa: BLE001
                pass


# ---- WorkOS status -----------------------------------------------------------------------------


def _val(v: Any) -> str:
    return str(getattr(v, "value", v) or "")


def _connection_state(state: str) -> Literal["active", "draft", "inactive"]:
    if state == "active":
        return "active"
    return "inactive" if state in ("inactive", "deleting") else "draft"


def _domain_state(state: str) -> Literal["verified", "pending"]:
    return "verified" if state in ("verified", "legacy_verified") else "pending"


async def _status(workos_org_id: str) -> dict[str, Any]:
    """{sso, directory, domains} for a WorkOS organization (cached 60 s)."""
    if (hit := _cache_get(workos_org_id)) is not None:
        return hit
    w = wclient.client()
    connections = [c async for c in (await w.sso.list_connections(organization_id=workos_org_id, limit=100)).auto_paging_iter()]
    directories = [d async for d in (await w.directory_sync.list_directories(organization_id=workos_org_id, limit=100)).auto_paging_iter()]
    org = await w.organizations.get_organization(workos_org_id)
    # The active connection wins; else the newest one (a draft being set up).
    conn = next((c for c in connections if _val(c.state) == "active"), connections[0] if connections else None)
    directory = next((d for d in directories if _val(d.state) == "linked"), directories[0] if directories else None)
    meta = getattr(directory, "metadata", None) if directory else None
    users = getattr(meta, "users", None)
    value = {
        "sso": {"provider": _val(conn.connection_type), "state": _connection_state(_val(conn.state))} if conn else None,
        "directory": {"provider": _val(directory.type), "users": int(getattr(users, "active", 0) or 0), "groups": int(getattr(meta, "groups", 0) or 0)} if directory else None,
        "domains": [{"domain": d.domain, "state": _domain_state(_val(d.state))} for d in (org.domains or [])],
    }
    _cache_put(workos_org_id, value)
    return value


def _workos_org(db: Session, ctx: RequestContext) -> tuple[str | None, str | None]:
    """(our org id, its WorkOS id) for the request."""
    org_id = current_org(db, ctx)
    row = db.get(Organization, org_id) if org_id else None
    return org_id, (row.workos_org_id if row is not None else None)


def _methods(sso_active: bool) -> list[dict[str, Any]]:
    on = {m.strip() for m in settings().signin_methods.split(",") if m.strip()}
    out = [{"id": mid, "name": name, "on": mid in on} for mid, name in METHODS]
    # Once SSO is active WorkOS sends the organization's people through their identity provider.
    out.append({"id": "sso", "name": "Single sign-on (SAML/OIDC)", "on": sso_active})
    return out


def workos_error(e: Exception) -> HTTPException:
    """A WorkOS SDK error as an HTTP error: 503 when transient, else its status and text."""
    from workos._errors import APIError, WorkOSConnectionError, WorkOSTimeoutError

    if isinstance(e, (WorkOSConnectionError, WorkOSTimeoutError)) or (isinstance(e, APIError) and ((e.status_code or 500) >= 500 or e.status_code == 429)):
        return HTTPException(503, "WorkOS is unavailable; try again")
    status = getattr(e, "status_code", None) or 502
    detail = str(getattr(e, "message", None) or getattr(e, "error_description", None) or e or type(e).__name__)
    return HTTPException(status if 400 <= status < 500 else 502, detail)


async def security_for(db: Session, ctx: RequestContext) -> dict[str, Any]:
    _, workos_org_id = _workos_org(db, ctx)
    status: dict[str, Any] = {"sso": None, "directory": None, "domains": []}
    if settings().workos and workos_org_id:
        try:
            status = await _status(workos_org_id)
        except Exception as e:  # noqa: BLE001
            raise workos_error(e) from None
    sso = status["sso"]
    return {
        "mfaRequired": False,
        "mfaEditable": False,
        "methods": _methods(bool(sso and sso["state"] == "active")),
        "sso": sso,
        "directory": status["directory"],
        "domains": status["domains"],
        "sessionHours": settings().session_max_hours,
    }


# ---- Routes ------------------------------------------------------------------------------------


@router.get("/org/security")
async def get_security(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    return await security_for(db, ctx)


@router.patch("/org/security")
async def patch_security(body: dict = Body(...), ctx: RequestContext = Depends(require_permission(ORG_MANAGE))):
    if "mfaRequired" not in body or not isinstance(body["mfaRequired"], bool):
        raise HTTPException(422, "mfaRequired (true or false) is required")
    raise HTTPException(409, MFA_NOT_EDITABLE)


class AdminPortalBody(BaseModel):
    intent: str


def _return_url() -> str | None:
    base = (settings().public_url or "").rstrip("/")
    return f"{base}/organization/security" if base else None


@router.post("/org/admin-portal")
async def admin_portal(body: AdminPortalBody, ctx: RequestContext = Depends(require_permission(ORG_MANAGE)), db: Session = Depends(get_session)):
    if body.intent not in INTENTS:
        raise HTTPException(422, f"intent must be one of {', '.join(INTENTS)}")
    org_id, workos_org_id = _workos_org(db, ctx)
    if settings().workos:
        if not workos_org_id:
            raise HTTPException(409, "this organization isn't linked to WorkOS yet")
        try:
            link = await wclient.client().admin_portal.generate_link(organization=workos_org_id, intent=body.intent, return_url=_return_url(), success_url=_return_url(), external_user_id=ctx.on_behalf_of or ctx.principal)
        except Exception as e:  # noqa: BLE001
            raise workos_error(e) from None
        url = link.link
    else:
        # Offline: a recognisable fake on the configured WorkOS base (never opened in dev).
        url = f"{wclient.base_url()}portal/dev?" + urlencode({"intent": body.intent, "organization": org_id or ""})
    audit(db, ctx, ADMIN_PORTAL_OPENED, target=org_id, org_id=org_id, detail={"intent": body.intent})
    return {"url": url}
