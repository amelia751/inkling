"""The signed-in session (todo9 Phase 3): unseal the cookie, verify the access token, refresh it.

Rules (WorkOS session resilience):

- An expired access token is refreshed with the refresh token, and the new sealed session is
  written back on the same response (refresh tokens rotate on every use; concurrent refreshes
  from several replicas converge within WorkOS's 30 s replay window).
- `invalid_grant` (and any other definite "no"): the session is over. Clear the cookie, 401.
- 408, 429, 5xx, network errors, an unreachable key set: transient. 503 and **keep** the
  cookie; never sign anyone out for a hiccup.

`session_middleware` does this once per `/api/*` request in workos mode and leaves the result
on `request.state.auth_session` for `context.resolve_context`. It also enforces the CSRF rule:
a state-changing request authenticated by the cookie must send `X-Requested-With: fetch`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import anyio
import jwt
from jwt.types import Options
from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..config import settings
from . import client as wclient
from . import cookie

log = logging.getLogger(__name__)

CSRF_HEADER = "X-Requested-With"
CSRF_VALUE = "fetch"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


class SessionError(Exception):
    """`status` 401 (sign in again; `clear` drops the cookie) or 503 (transient; keep it).
    `reauth` marks a refresh WorkOS refused until the person authenticates again (SSO or MFA
    required by the organization): switch-org answers it with a sign-in redirect."""

    def __init__(self, status: int, detail: str, *, clear: bool = False, reauth: bool = False):
        super().__init__(detail)
        self.status, self.detail, self.clear, self.reauth = status, detail, clear, reauth


@dataclass
class AuthSession:
    """A verified WorkOS session. `sealed` is set when it was refreshed: the new cookie value."""

    user: dict[str, Any]
    claims: dict[str, Any]
    access_token: str
    impersonator: dict[str, Any] | None = None
    sealed: str | None = None
    permissions: tuple[str, ...] = field(default_factory=tuple)

    @property
    def principal(self) -> str:
        return f"user:{self.claims['sub']}"

    @property
    def session_id(self) -> str | None:
        return self.claims.get("sid")

    @property
    def org_id(self) -> str | None:
        """The WorkOS organization id (`org_id` claim), not ours."""
        return self.claims.get("org_id")

    @property
    def role(self) -> str | None:
        return self.claims.get("role")

    @property
    def expires_at(self) -> datetime | None:
        exp = self.claims.get("exp")
        return datetime.fromtimestamp(exp, UTC) if exp else None


def decode_access_token(token: str, *, verify_exp: bool = True) -> dict[str, Any]:
    """Verify a WorkOS access token against the environment's JWKS (RS256). Raises
    `jwt.ExpiredSignatureError`, `jwt.InvalidTokenError`, or `jwt.PyJWKClientError` (key set
    unreachable)."""
    issuer = settings().workos_issuer or None
    options: Options = {"verify_aud": False, "verify_exp": verify_exp}
    if issuer is None:
        options["verify_iss"] = False
    return jwt.decode(token, wclient.signing_key(token), algorithms=["RS256"], options=options, issuer=issuer, leeway=5)


def _unseal(sealed: str) -> dict[str, Any]:
    from workos.session import unseal_data

    try:
        data = unseal_data(sealed, settings().workos_cookie_password or "")
    except Exception:  # noqa: BLE001 — a cookie we can't open (other key, tampered): sign in again
        raise SessionError(401, "session cookie is invalid", clear=True) from None
    if not isinstance(data, dict) or not data.get("access_token"):
        raise SessionError(401, "session cookie is invalid", clear=True)
    return data


def seal(access_token: str, refresh_token: str, user: dict[str, Any], impersonator: dict[str, Any] | None) -> str:
    from workos.session import seal_session_from_auth_response

    return seal_session_from_auth_response(access_token=access_token, refresh_token=refresh_token, user=user, impersonator=impersonator, cookie_password=settings().workos_cookie_password or "")


def _verified(data: dict[str, Any], token: str, sealed: str | None) -> AuthSession:
    """Decode a token we just got from WorkOS (after a code exchange or a refresh)."""
    try:
        claims = decode_access_token(token)
    except jwt.PyJWKClientError:
        raise SessionError(503, "can't verify the session right now; try again") from None
    except jwt.InvalidTokenError:
        # A fresh token that doesn't verify means our issuer or key settings are wrong, not
        # that the person signed out: keep the cookie and say so.
        log.error("a fresh WorkOS access token failed verification (check API_WORKOS_ISSUER)")
        raise SessionError(503, "can't verify the session right now; try again") from None
    return AuthSession(user=data.get("user") or {}, claims=claims, access_token=token, impersonator=data.get("impersonator"), sealed=sealed, permissions=tuple(claims.get("permissions") or ()))


def _classify(e: Exception) -> SessionError:
    """A WorkOS refresh error → terminal (401, clear) or transient (503, keep)."""
    from workos._errors import APIError, AuthenticationFlowError, WorkOSConnectionError, WorkOSTimeoutError

    if isinstance(e, AuthenticationFlowError):
        return SessionError(401, str(getattr(e, "message", "") or "sign in again to continue"), clear=False, reauth=True)
    if isinstance(e, (WorkOSConnectionError, WorkOSTimeoutError)):
        return SessionError(503, "WorkOS is unreachable; try again")
    if isinstance(e, APIError):
        status = e.status_code or 500
        if status in (408, 429) or status >= 500:
            return SessionError(503, "WorkOS is unavailable; try again")
        return SessionError(401, "your session has ended; sign in again", clear=True)
    log.warning("unexpected refresh error: %s", type(e).__name__)
    return SessionError(503, "can't refresh the session right now; try again")


async def refresh(sealed: str, *, organization_id: str | None = None, ip: str | None = None, user_agent: str | None = None) -> AuthSession:
    """Exchange the cookie's refresh token (optionally into another WorkOS organization).
    Returns the session with `sealed` set to the new cookie value; raises `SessionError`."""
    data = _unseal(sealed)
    if not data.get("refresh_token"):
        raise SessionError(401, "session cookie is invalid", clear=True)
    try:
        resp = await wclient.client().user_management.authenticate_with_refresh_token(refresh_token=data["refresh_token"], organization_id=organization_id, ip_address=ip, user_agent=user_agent)
    except Exception as e:  # noqa: BLE001 — classified below
        raise _classify(e) from None
    user = resp.user.to_dict() if hasattr(resp.user, "to_dict") else dict(resp.user)
    imp = resp.impersonator.to_dict() if getattr(resp, "impersonator", None) is not None and hasattr(resp.impersonator, "to_dict") else None
    new_sealed = seal(resp.access_token, resp.refresh_token, user, imp)
    return _verified({"user": user, "impersonator": imp}, resp.access_token, new_sealed)


async def current_session(request: Request) -> AuthSession | None:
    """The request's signed-in session (refreshed when its access token expired), None without
    a cookie. Raises `SessionError`."""
    sealed = cookie.read_session(request)
    if not sealed:
        return None
    data = _unseal(sealed)
    token = data["access_token"]
    try:
        claims = await anyio.to_thread.run_sync(decode_access_token, token)
    except jwt.ExpiredSignatureError:
        from ..context import client_ip

        try:
            return await refresh(sealed, ip=client_ip(request), user_agent=request.headers.get("User-Agent"))
        except SessionError as e:
            if e.reauth:  # SSO/MFA now required: sign in again (the hosted page does it)
                raise SessionError(401, e.detail, clear=True) from None
            raise
    except jwt.PyJWKClientError:
        raise SessionError(503, "can't verify the session right now; try again") from None
    except jwt.InvalidTokenError:
        raise SessionError(401, "session is invalid; sign in again", clear=True) from None
    return AuthSession(user=data.get("user") or {}, claims=claims, access_token=token, impersonator=data.get("impersonator"), permissions=tuple(claims.get("permissions") or ()))


def error_response(e: SessionError) -> JSONResponse:
    resp = JSONResponse({"detail": e.detail}, status_code=e.status)
    if e.clear:
        cookie.clear_session(resp)
    if e.status == 503:
        resp.headers["Retry-After"] = "2"
    return resp


async def session_middleware(request: Request, call_next):
    """workos mode: authenticate `/api/*` requests that carry the session cookie (and no
    Bearer), refresh and rewrite the cookie, enforce the CSRF header. `/api/auth/*` handles its
    own cookies."""
    path = request.url.path
    if not settings().workos or not path.startswith("/api/") or path.startswith("/api/auth/") or request.headers.get("Authorization", "").startswith("Bearer ") or not cookie.read_session(request):
        return await call_next(request)
    try:
        s = await current_session(request)
    except SessionError as e:
        return error_response(e)
    if request.method.upper() not in SAFE_METHODS and request.headers.get(CSRF_HEADER) != CSRF_VALUE:
        return JSONResponse({"detail": f"missing {CSRF_HEADER}: {CSRF_VALUE}"}, status_code=403)
    request.state.auth_session = s
    resp = await call_next(request)
    if s is not None and s.sealed:
        cookie.set_session(resp, s.sealed)
    return resp


# ---- Revocation (todo9 Phase 5): kernel session tokens a person delegated -----------------------


def revoke_sessions_for(db: Session, principal: str, org_id: str | None = None) -> int:
    """Delete the kernel session tokens minted on behalf of `principal` (agent runs), in
    `org_id` when given (tokens minted in dev, without an org, go too). Used when a member is
    removed or deactivated (Phase 6, Phase 7 events). Returns how many were revoked."""
    from ..models import SessionDelegation, SessionToken

    q = select(SessionDelegation.token_hash).where(SessionDelegation.on_behalf_of == principal)
    if org_id is not None:
        q = q.where((SessionDelegation.org_id == org_id) | SessionDelegation.org_id.is_(None))
    hashes = list(db.scalars(q))
    if not hashes:
        return 0
    db.execute(delete(SessionDelegation).where(SessionDelegation.token_hash.in_(hashes)))
    db.execute(delete(SessionToken).where(SessionToken.token_hash.in_(hashes)))
    db.flush()
    return len(hashes)
