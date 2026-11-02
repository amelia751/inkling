"""Sign-in routes (todo9 Phase 3, D1: the api owns the session, the SPA never sees a token).

    GET  /api/auth/login?return_to=&organization_id=&invitation_token=&login_hint=&screen_hint=&max_age=
                                  → 302 to hosted AuthKit (state + PKCE in a signed 10 min cookie)
    GET  /api/auth/callback?code=&state=   → 302 to return_to, sets the sealed session cookie
    GET  /api/auth/session                 → Session (dev mode: the dev identity, every permission)
    POST /api/auth/switch-org {organizationId} → {ok: true} | {redirect} (SSO/MFA required there)
    POST /api/auth/logout                  → {url}: the WorkOS logout URL; clears the cookie
    GET  /api/auth/verify                  → 200 + X-Access-Token (nginx auth_request; internal)

State-changing routes need `X-Requested-With: fetch` (CSRF; SameSite=Lax covers the rest).
In dev mode login and callback just redirect, and logout answers `/`.
"""

from __future__ import annotations

import hmac
import logging
import secrets
from typing import Any
from urllib.parse import urlencode

import anyio
from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response
from sqlalchemy import select

from ..config import settings
from ..context import AUTH_DEV, client_ip, resolve_context
from ..db import session_scope
from ..models import Organization, OrganizationMember, User
from . import bootstrap, cookie
from . import client as wclient
from .audit import ORG_SWITCHED, SIGNED_IN, SIGNED_OUT, record_event
from .invitations import accept_for_email
from .permissions import PERMISSIONS
from .session import CSRF_HEADER, CSRF_VALUE, AuthSession, SessionError, _verified, current_session, decode_access_token, error_response, refresh, seal

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])


def safe_return_to(value: str | None) -> str:
    """Only a same-origin path: `/…`, never `//host`, a scheme, a backslash or a newline."""
    v = (value or "/").strip()
    if not v.startswith("/") or v.startswith("//") or "\\" in v or "\r" in v or "\n" in v:
        return "/"
    return v[:2048]


def _require_csrf(request: Request) -> None:
    if request.headers.get(CSRF_HEADER) != CSRF_VALUE:
        raise HTTPException(403, f"missing {CSRF_HEADER}: {CSRF_VALUE}")


def _transient(e: Exception) -> bool:
    from workos._errors import APIError, WorkOSConnectionError, WorkOSTimeoutError

    if isinstance(e, (WorkOSConnectionError, WorkOSTimeoutError)):
        return True
    return isinstance(e, APIError) and ((e.status_code or 500) >= 500 or e.status_code in (408, 429))


def _workos_message(e: Exception) -> str:
    return str(getattr(e, "error_description", None) or getattr(e, "message", None) or type(e).__name__)


def _workos_org_param(organization_id: str | None) -> str | None:
    """`organization_id` may be ours or WorkOS's; WorkOS wants its own."""
    if not organization_id:
        return None
    with session_scope() as db:
        row = db.get(Organization, organization_id)
        return row.workos_org_id if row is not None and row.workos_org_id else organization_id


# ---- Login and callback ------------------------------------------------------------------------


@router.get("/login")
async def login(request: Request, return_to: str | None = None, organization_id: str | None = None, invitation_token: str | None = None, login_hint: str | None = None, screen_hint: str | None = None, max_age: int | None = None):
    target = safe_return_to(return_to)
    if not settings().workos:
        return RedirectResponse(target, status_code=302)
    from workos.pkce import PKCE

    pair = PKCE().generate()
    state = secrets.token_urlsafe(32)
    workos_org = await anyio.to_thread.run_sync(_workos_org_param, organization_id)
    url = wclient.client().user_management.get_authorization_url(
        provider="authkit", redirect_uri=settings().workos_redirect_uri, state=state, code_challenge=pair.code_challenge, code_challenge_method="S256",
        organization_id=workos_org, invitation_token=invitation_token, login_hint=login_hint,
        screen_hint="sign-up" if screen_hint == "sign-up" else None, max_age=max_age,
    )
    resp = RedirectResponse(url, status_code=302)
    cookie.set_state(resp, {"s": state, "v": pair.code_verifier, "r": target, **({"o": workos_org} if workos_org else {})})
    return resp


def _fail(status: int, detail: str) -> JSONResponse:
    resp = JSONResponse({"detail": detail}, status_code=status)
    cookie.clear_state(resp)
    return resp


async def _exchange_code(code: str, st: dict[str, Any], ip: str | None, ua: str | None) -> Any:
    """The code → tokens. A person in several organizations can get `organization_selection_required`
    back (WorkOS Emulate always does; hosted AuthKit usually asks on its own page first): finish
    in the organization the sign-in asked for, else the first one offered. The switcher does the rest."""
    from workos._errors import OrganizationSelectionRequiredError

    um = wclient.client().user_management
    try:
        return await um.authenticate_with_code(code=code, code_verifier=st.get("v"), ip_address=ip, user_agent=ua)
    except OrganizationSelectionRequiredError as e:
        offered = [str(o.get("id")) for o in (e.organizations or []) if o.get("id")]
        if not offered or not e.pending_authentication_token:
            raise
        pick = st.get("o") if st.get("o") in offered else offered[0]
        return await um.authenticate_with_organization_selection(pending_authentication_token=e.pending_authentication_token, organization_id=pick, ip_address=ip, user_agent=ua)


@router.get("/callback")
async def callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None, error_description: str | None = None):
    if not settings().workos:
        return RedirectResponse("/", status_code=302)
    if error:
        return _fail(400, f"sign-in failed: {error_description or error}")
    st = cookie.verify_state(request.cookies.get(cookie.state_cookie_name()))
    if st is None or not code or not state or not hmac.compare_digest(str(st.get("s", "")), state):
        return _fail(400, "sign-in state didn't match; start again from the sign-in page")
    ip, ua = client_ip(request), request.headers.get("User-Agent")
    try:
        auth = await _exchange_code(code, st, ip, ua)
    except Exception as e:  # noqa: BLE001 — WorkOS text goes back as the detail
        if _transient(e):
            return _fail(503, "WorkOS is unavailable; try signing in again")
        return _fail(400, f"sign-in failed: {_workos_message(e)}")
    user = auth.user.to_dict()
    imp = auth.impersonator.to_dict() if auth.impersonator is not None else None
    try:
        sealed = seal(auth.access_token, auth.refresh_token, user, imp)
        s = _verified({"user": user, "impersonator": imp}, auth.access_token, sealed)
        with session_scope() as db:
            principal = bootstrap.upsert_user(db, user)
            if s.org_id is None:
                # First sign-in without an organization: a personal one, then a session in it.
                workos_org = await bootstrap.personal_org(db, user["id"])
                s = await refresh(sealed, organization_id=workos_org, ip=ip, user_agent=ua)
                sealed = s.sealed or sealed
            our_org = bootstrap.org_for_workos_id(db, s.org_id) if s.org_id else None
            if our_org:
                bootstrap.ensure_membership(db, our_org, principal, s.role)
                # Hosted AuthKit accepted an invitation: its project grants become project roles.
                accept_for_email(db, our_org, principal, str(user.get("email") or ""))
            record_event(db, org_id=our_org, actor=principal, action=SIGNED_IN, target=principal, ip=ip, user_agent=ua, detail={"sessionId": s.session_id})
    except SessionError as e:
        return _fail(e.status, e.detail)
    except Exception as e:  # noqa: BLE001
        if _transient(e):
            return _fail(503, "WorkOS is unavailable; try signing in again")
        log.exception("sign-in bootstrap failed")
        return _fail(500, f"sign-in failed: {type(e).__name__}")
    resp = RedirectResponse(str(st.get("r") or "/"), status_code=302)
    cookie.set_session(resp, sealed)
    cookie.clear_state(resp)
    return resp


# ---- Session -----------------------------------------------------------------------------------


def _name(first: str | None, last: str | None, email: str) -> str:
    return " ".join(p for p in (first, last) if p) or email


def _org_dict(o: Organization) -> dict[str, Any]:
    return {"id": o.id, "workosOrgId": o.workos_org_id, "name": o.name}


def _dev_session(request: Request) -> dict[str, Any]:
    from ..kernel.projects import ensure_principal

    with session_scope() as db:
        ctx = resolve_context(request, db)
        principal = ctx.principal
        org_id = ensure_principal(db, principal)
        orgs = list(db.scalars(select(Organization).join(OrganizationMember, OrganizationMember.org_id == Organization.id).where(OrganizationMember.principal == principal).order_by(Organization.kind.desc(), Organization.name)))
        current = next((o for o in orgs if o.id == org_id), orgs[0] if orgs else None)
        u = db.get(User, principal)
        local = principal.split(":", 1)[1]
        email = u.email if u else f"{local}@localhost"
        first = u.first_name if u else " ".join(w.capitalize() for w in local.replace("_", "-").split("-"))
        last = u.last_name if u else None
        return {
            "mode": "dev",
            "user": {"id": principal, "workosUserId": u.workos_user_id if u else "", "email": email, "firstName": first, "lastName": last, "name": _name(first, last, email), "avatarUrl": u.avatar_url if u else None},
            "organization": _org_dict(current) if current else {"id": "", "workosOrgId": None, "name": ""},
            "role": "admin",
            "permissions": list(PERMISSIONS),
            "organizations": [_org_dict(o) for o in orgs],
            "impersonator": None,
            "expiresAt": None,
        }


async def _workos_session(s: AuthSession) -> dict[str, Any]:
    u = s.user
    email = str(u.get("email") or "")
    with session_scope() as db:
        # The memberships first: they name organizations we only knew by id.
        orgs = await bootstrap.memberships(db, str(u.get("id") or s.claims["sub"]))
        org: dict[str, Any] = {"id": "", "workosOrgId": None, "name": ""}
        if s.org_id:
            row = db.get(Organization, bootstrap.org_for_workos_id(db, s.org_id))
            if row is not None:
                org = _org_dict(row)
    imp = s.impersonator
    return {
        "mode": "workos",
        "user": {"id": s.principal, "workosUserId": s.claims["sub"], "email": email, "firstName": u.get("first_name"), "lastName": u.get("last_name"), "name": _name(u.get("first_name"), u.get("last_name"), email), "avatarUrl": u.get("profile_picture_url")},
        "organization": org,
        "role": s.role or "member",
        "permissions": list(s.permissions),
        "organizations": orgs or ([org] if org["id"] else []),
        "impersonator": {"email": imp.get("email"), "reason": imp.get("reason")} if imp else None,
        "expiresAt": s.expires_at.isoformat().replace("+00:00", "Z") if s.expires_at else None,
    }


def _with_cookie(resp: Response, s: AuthSession) -> Response:
    if s.sealed:
        cookie.set_session(resp, s.sealed)
    return resp


@router.get("/session")
async def session_info(request: Request):
    if not settings().workos:
        return await anyio.to_thread.run_sync(_dev_session, request)
    try:
        s = await current_session(request)
    except SessionError as e:
        return error_response(e)
    if s is None:
        return JSONResponse({"detail": "not signed in"}, status_code=401)
    return _with_cookie(JSONResponse(await _workos_session(s)), s)


# ---- Organization switch, logout, verify --------------------------------------------------------


def _dev_switch(request: Request, organization_id: str) -> dict[str, Any]:
    with session_scope() as db:
        ctx = resolve_context(request, db)
        if ctx.auth != AUTH_DEV or db.get(OrganizationMember, (organization_id, ctx.principal)) is None:
            raise HTTPException(404, "no such organization")
    return {"ok": True}


@router.post("/switch-org")
async def switch_org(request: Request, body: dict = Body(...)):
    _require_csrf(request)
    target = str(body.get("organizationId") or "")
    if not target:
        raise HTTPException(422, "organizationId is required")
    if not settings().workos:
        return await anyio.to_thread.run_sync(_dev_switch, request, target)
    try:
        s = await current_session(request)
    except SessionError as e:
        return error_response(e)
    if s is None:
        return JSONResponse({"detail": "not signed in"}, status_code=401)
    with session_scope() as db:
        row = db.get(Organization, target) or db.scalar(select(Organization).where(Organization.workos_org_id == target))
        our_id, workos_id = (row.id, row.workos_org_id) if row is not None else (None, None)
    if not workos_id:
        raise HTTPException(404, "no such organization")
    ip, ua = client_ip(request), request.headers.get("User-Agent")
    try:
        new = await refresh(s.sealed or cookie.read_session(request) or "", organization_id=workos_id, ip=ip, user_agent=ua)
    except SessionError as e:
        if e.reauth:  # the organization requires SSO or MFA: sign in into it
            return {"redirect": "/api/auth/login?" + urlencode({"organization_id": our_id, "return_to": "/"})}
        return error_response(e)
    with session_scope() as db:
        bootstrap.ensure_membership(db, our_id, new.principal, new.role)
        record_event(db, org_id=our_id, actor=new.principal, action=ORG_SWITCHED, target=our_id, ip=ip, user_agent=ua, detail={"from": s.org_id and bootstrap.org_for_workos_id(db, s.org_id)})
    bootstrap.forget_memberships(new.claims.get("sub"))
    return _with_cookie(JSONResponse({"ok": True}), new)


@router.post("/logout")
async def logout(request: Request):
    _require_csrf(request)
    if not settings().workos:
        return {"url": "/"}
    url = settings().public_url or "/"
    sealed = cookie.read_session(request)
    if sealed:
        try:
            from workos.session import unseal_data

            data = unseal_data(sealed, settings().workos_cookie_password or "")
            claims = await anyio.to_thread.run_sync(lambda: decode_access_token(data["access_token"], verify_exp=False))
            url = wclient.client().user_management.get_logout_url(session_id=claims["sid"], return_to=settings().public_url or None)
            with session_scope() as db:
                our_org = bootstrap.org_for_workos_id(db, claims["org_id"]) if claims.get("org_id") else None
                record_event(db, org_id=our_org, actor=f"user:{claims['sub']}", action=SIGNED_OUT, target=f"user:{claims['sub']}", ip=client_ip(request), user_agent=request.headers.get("User-Agent"), detail={"sessionId": claims.get("sid")})
        except Exception:  # noqa: BLE001 — a dead cookie still signs out locally
            log.info("logout without a readable session", exc_info=True)
    resp = JSONResponse({"url": url})
    cookie.clear_session(resp)
    return resp


@router.get("/verify", include_in_schema=False)
async def verify(request: Request):
    """For nginx `auth_request` in front of the agent: the person's WorkOS access token in
    `X-Access-Token` (refreshed first when expired). A refresh rotates the cookie: nginx must
    pass this response's `Set-Cookie` on (`auth_request_set $auth_cookie
    $upstream_http_set_cookie; add_header Set-Cookie $auth_cookie;`), or the browser keeps a
    spent refresh token. Not routed by the ingress. dev mode: 200 without a token."""
    if not settings().workos:
        return Response(status_code=200, headers={"X-Auth-Mode": "dev"})
    try:
        s = await current_session(request)
    except SessionError as e:
        return error_response(e)
    if s is None:
        return JSONResponse({"detail": "not signed in"}, status_code=401)
    return _with_cookie(Response(status_code=200, headers={"X-Access-Token": s.access_token, "Cache-Control": "no-store"}), s)
