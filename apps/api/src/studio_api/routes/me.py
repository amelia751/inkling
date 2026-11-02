"""Your profile (todo9 Phase 11): the signed-in person's own account.

    GET   /api/v1/me                          → Me
    PATCH /api/v1/me {firstName?, lastName?, marketing?} → Me
    POST  /api/v1/me/email-change {newEmail}  → {newEmail, expiresAt}: WorkOS mails a code there
    POST  /api/v1/me/email-change/confirm {code} → Me
    GET   /api/v1/me/sessions                 → {sessions: MySession[]}
    DELETE /api/v1/me/sessions/{id}           → 204 (one of your other sessions)
    POST  /api/v1/me/sessions/revoke-others   → 204
    GET   /api/v1/me/mfa-url                  → {url, hint}

workos mode: names go to WorkOS (`update_user`) and the local `users` mirror, and the session
cookie is resealed with the new names so the account menu shows them at once. `marketing` is
our own column. People who signed in with SSO (`auth_method` of the current session) have their
profile managed by their identity provider: names and email can't be changed here.

MFA: hosted AuthKit has no stand-alone "enroll an authenticator" page. Enrollment happens at
sign-in when MFA is required (environment-wide or by the organization's policy), so the URL is a
fresh sign-in (`max_age=0`) that comes back to the profile page; `hint` says so.

dev mode works offline: the profile lives in the local `users` table (created on first change),
and the session list is one fake, current session.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import audit, bootstrap
from ..auth import client as wclient
from ..config import settings
from ..context import AUTH_COOKIE, AUTH_DEV, RequestContext, get_context
from ..db import get_session
from ..models import User, now
from .org_security import workos_error as _workos_error

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1")

PROFILE_UPDATED = "profile.updated"
EMAIL_CHANGE_REQUESTED = "profile.email_change_requested"
EMAIL_CHANGED = "profile.email_changed"
SESSION_REVOKED = "session.revoked"
OTHER_SESSIONS_REVOKED = "session.revoked_others"

DEV_SESSION_ID = "session_dev"
PROFILE_PATH = "/settings/profile"
MFA_HINT = "AuthKit sets up an authenticator app during sign-in when multi-factor authentication is required; this link signs you in again to do it."
NAME_MAX = 256


def _iso(d: datetime | None) -> str | None:
    if d is None:
        return None
    d = d if d.tzinfo else d.replace(tzinfo=UTC)
    return d.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _person(ctx: RequestContext) -> str:
    """Only a person, in the browser (cookie or dev identity), manages their own profile: not an
    agent token or an API key."""
    if ctx.auth not in (AUTH_COOKIE, AUTH_DEV) or not ctx.principal.startswith("user:"):
        raise HTTPException(403, "only a signed-in person can manage their profile")
    return ctx.principal


def _workos_user_id(principal: str) -> str:
    return principal.split(":", 1)[1]


def _auth_session(request: Request) -> Any:
    return getattr(request.state, "auth_session", None)


# ---- The current session's sign-in method (sid → auth_method never changes; cached) -------------

_AUTH_METHOD_TTL_S = 600.0
_auth_methods: dict[str, tuple[float, str]] = {}


async def _list_sessions(workos_user_id: str) -> list[Any]:
    page = await wclient.client().user_management.list_sessions(workos_user_id, limit=100)
    return [s async for s in page.auto_paging_iter()]


async def _sso_managed(ctx: RequestContext) -> bool:
    if not settings().workos or not ctx.session_id:
        return False
    sid = ctx.session_id
    hit = _auth_methods.get(sid)
    if hit and time.monotonic() - hit[0] < _AUTH_METHOD_TTL_S:
        return hit[1] == "sso"
    try:
        sessions = await _list_sessions(_workos_user_id(ctx.principal))
    except Exception:  # noqa: BLE001 — unknown: treat as self-managed; WorkOS still refuses edits it won't allow
        log.warning("listing WorkOS sessions failed; ssoManaged unknown", exc_info=True)
        return False
    for s in sessions:
        _auth_methods[s.id] = (time.monotonic(), str(getattr(s.auth_method, "value", s.auth_method)))
    hit = _auth_methods.get(sid)
    return bool(hit and hit[1] == "sso")


def forget_auth_methods() -> None:
    """Tests."""
    _auth_methods.clear()


# ---- Me ----------------------------------------------------------------------------------------


def _dev_names(principal: str) -> tuple[str, str | None, str]:
    local = principal.split(":", 1)[1]
    return " ".join(w.capitalize() for w in local.replace("_", "-").split("-")), None, f"{local}@localhost"


def _me(db: Session, request: Request, principal: str, sso: bool) -> dict[str, Any]:
    u = db.scalar(select(User).where(User.id == principal).execution_options(populate_existing=True))
    if u is not None:
        return {"id": principal, "email": u.email, "firstName": u.first_name, "lastName": u.last_name, "marketing": bool(u.marketing), "ssoManaged": sso}
    s = _auth_session(request)
    if s is not None:
        su = s.user or {}
        return {"id": principal, "email": str(su.get("email") or ""), "firstName": su.get("first_name"), "lastName": su.get("last_name"), "marketing": False, "ssoManaged": sso}
    first, last, email = _dev_names(principal)
    return {"id": principal, "email": email, "firstName": first, "lastName": last, "marketing": False, "ssoManaged": False}


def _ensure_dev_user(db: Session, principal: str) -> User:
    u = db.get(User, principal)
    if u is None:
        first, last, email = _dev_names(principal)
        u = User(id=principal, workos_user_id=f"dev:{_workos_user_id(principal)}", email=email, first_name=first, last_name=last, created_at=now())
        db.add(u)
        db.flush()
    return u


def _name_field(body: dict, key: str) -> str | None:
    v = body.get(key)
    if v is None:
        return None
    if not isinstance(v, str) or len(v.strip()) > NAME_MAX:
        raise HTTPException(422, f"{key} must be text of at most {NAME_MAX} characters")
    return v.strip()


def _reseal(request: Request, user: dict[str, Any]) -> None:
    """Put the new names into the session cookie (the middleware writes `sealed` back)."""
    from ..auth import cookie
    from ..auth.session import _unseal, seal

    s = _auth_session(request)
    current = (s.sealed if s is not None else None) or cookie.read_session(request)
    if s is None or not current:
        return
    data = _unseal(current)
    s.user = {**(data.get("user") or {}), **user}
    s.sealed = seal(data["access_token"], data["refresh_token"], s.user, data.get("impersonator"))


@router.get("/me")
async def get_me(request: Request, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    principal = _person(ctx)
    return _me(db, request, principal, await _sso_managed(ctx))


@router.patch("/me")
async def patch_me(request: Request, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    principal = _person(ctx)
    first, last = _name_field(body, "firstName"), _name_field(body, "lastName")
    marketing = body.get("marketing")
    if marketing is not None and not isinstance(marketing, bool):
        raise HTTPException(422, "marketing must be true or false")
    if first is not None and not first:
        raise HTTPException(422, "firstName can't be empty")
    changed: list[str] = []
    sso = await _sso_managed(ctx)
    names = {k: v for k, v in (("first_name", first), ("last_name", last)) if v is not None}
    if settings().workos:
        if names and sso:
            raise HTTPException(409, "your name is managed by your organization's identity provider")
        if names:
            try:
                updated = await wclient.client().user_management.update_user(_workos_user_id(principal), **names)
            except Exception as e:  # noqa: BLE001
                raise _workos_error(e) from None
            user = updated.to_dict() if hasattr(updated, "to_dict") else dict(updated)
            bootstrap.upsert_user(db, user)
            _reseal(request, {"first_name": user.get("first_name"), "last_name": user.get("last_name")})
            changed += [k for k in ("firstName", "lastName") if body.get(k) is not None]
        if marketing is not None:
            u = db.get(User, principal)
            if u is None:  # signed in before the mirror existed: the session's user
                s = _auth_session(request)
                bootstrap.upsert_user(db, (s.user if s is not None and s.user else {"id": _workos_user_id(principal)}))
                u = db.get(User, principal)
            if u is not None and u.marketing != marketing:
                u.marketing = marketing
                changed.append("marketing")
    else:
        u = _ensure_dev_user(db, principal)
        for key, col in (("firstName", "first_name"), ("lastName", "last_name")):
            v = first if key == "firstName" else last
            if v is not None and getattr(u, col) != (v or None):
                setattr(u, col, v or None)
                changed.append(key)
        if marketing is not None and u.marketing != marketing:
            u.marketing = marketing
            changed.append("marketing")
    db.flush()
    if changed:
        audit(db, ctx, PROFILE_UPDATED, target=principal, org_id=bootstrap.current_org(db, ctx), detail={"fields": changed})
    return _me(db, request, principal, sso)


# ---- Email change (password users; WorkOS mails a one-time code to the new address) -------------


@router.post("/me/email-change")
async def send_email_change(body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    principal = _person(ctx)
    new_email = str(body.get("newEmail") or "").strip().lower()
    if "@" not in new_email or len(new_email) > 320:
        raise HTTPException(422, "newEmail must be an email address")
    if not settings().workos:
        raise HTTPException(409, "email changes need WorkOS sign-in (auth mode workos)")
    if await _sso_managed(ctx):
        raise HTTPException(409, "your email is managed by your organization's identity provider")
    try:
        change = await wclient.client().user_management.send_email_change(_workos_user_id(principal), new_email=new_email)
    except Exception as e:  # noqa: BLE001
        raise _workos_error(e) from None
    audit(db, ctx, EMAIL_CHANGE_REQUESTED, target=principal, org_id=bootstrap.current_org(db, ctx))
    return {"newEmail": change.new_email, "expiresAt": _iso(change.expires_at)}


@router.post("/me/email-change/confirm")
async def confirm_email_change(request: Request, body: dict = Body(...), ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    principal = _person(ctx)
    code = str(body.get("code") or "").strip()
    if not code:
        raise HTTPException(422, "code is required")
    if not settings().workos:
        raise HTTPException(409, "email changes need WorkOS sign-in (auth mode workos)")
    w = wclient.client().user_management
    try:
        await w.confirm_email_change(_workos_user_id(principal), code=code)
        updated = await w.get_user(_workos_user_id(principal))
    except Exception as e:  # noqa: BLE001
        raise _workos_error(e) from None
    user = updated.to_dict() if hasattr(updated, "to_dict") else dict(updated)
    bootstrap.upsert_user(db, user)
    _reseal(request, {"email": user.get("email"), "email_verified": user.get("email_verified")})
    audit(db, ctx, EMAIL_CHANGED, target=principal, org_id=bootstrap.current_org(db, ctx))
    return _me(db, request, principal, False)


# ---- Sessions ----------------------------------------------------------------------------------


def _session(s: Any, current: str | None) -> dict[str, Any]:
    return {"id": s.id, "current": s.id == current, "ipAddress": s.ip_address, "userAgent": s.user_agent, "createdAt": _iso(s.created_at), "expiresAt": _iso(s.expires_at)}


def _active(s: Any) -> bool:
    return str(getattr(s.status, "value", s.status) or "active") == "active"


@router.get("/me/sessions")
async def my_sessions(ctx: RequestContext = Depends(get_context)):
    principal = _person(ctx)
    if not settings().workos:
        return {"sessions": [{"id": DEV_SESSION_ID, "current": True, "ipAddress": ctx.client_ip, "userAgent": ctx.user_agent, "createdAt": _iso(now()), "expiresAt": None}]}
    try:
        sessions = await _list_sessions(_workos_user_id(principal))
    except Exception as e:  # noqa: BLE001
        raise _workos_error(e) from None
    rows = [_session(s, ctx.session_id) for s in sessions if _active(s)]
    rows.sort(key=lambda r: r["createdAt"] or "", reverse=True)
    rows.sort(key=lambda r: not r["current"])  # stable: this device first, then newest
    return {"sessions": rows}


async def _revoke(ids: list[str]) -> None:
    w = wclient.client().user_management
    for sid in ids:
        try:
            await w.revoke_session(session_id=sid)
        except Exception as e:  # noqa: BLE001
            raise _workos_error(e) from None


@router.delete("/me/sessions/{session_id}", status_code=204)
async def revoke_my_session(session_id: str, ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    principal = _person(ctx)
    current = ctx.session_id if settings().workos else DEV_SESSION_ID
    if session_id == current:
        raise HTTPException(409, "this is your current session: sign out instead")
    if not settings().workos:
        raise HTTPException(404, "no such session")
    try:
        mine = {s.id for s in await _list_sessions(_workos_user_id(principal)) if _active(s)}
    except Exception as e:  # noqa: BLE001
        raise _workos_error(e) from None
    if session_id not in mine:  # never revoke someone else's session by id
        raise HTTPException(404, "no such session")
    await _revoke([session_id])
    audit(db, ctx, SESSION_REVOKED, target=session_id, org_id=bootstrap.current_org(db, ctx))
    return Response(status_code=204)


@router.post("/me/sessions/revoke-others", status_code=204)
async def revoke_other_sessions(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    principal = _person(ctx)
    others: list[str] = []
    if settings().workos:
        try:
            others = [s.id for s in await _list_sessions(_workos_user_id(principal)) if _active(s) and s.id != ctx.session_id]
        except Exception as e:  # noqa: BLE001
            raise _workos_error(e) from None
        await _revoke(others)
    audit(db, ctx, OTHER_SESSIONS_REVOKED, target=principal, org_id=bootstrap.current_org(db, ctx), detail={"count": len(others)})
    return Response(status_code=204)


# ---- MFA ---------------------------------------------------------------------------------------


@router.get("/me/mfa-url")
async def mfa_url(ctx: RequestContext = Depends(get_context), db: Session = Depends(get_session)):
    principal = _person(ctx)
    params: dict[str, str] = {"return_to": PROFILE_PATH}
    if settings().workos:
        params["max_age"] = "0"
        u = db.get(User, principal)
        if u is not None and u.email:
            params["login_hint"] = u.email
    return {"url": "/api/auth/login?" + urlencode(params), "hint": MFA_HINT}
