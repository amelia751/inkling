"""Cookies (todo9 Phase 3): the sealed session and the short-lived sign-in state.

- `<namespace>_session`: the WorkOS session sealed with `API_WORKOS_COOKIE_PASSWORD` (Fernet:
  access token, refresh token, user). HttpOnly, SameSite=Lax, Path=/, host-only, Secure unless
  the Studio is served over plain http (local dev), max-age = the 12 h maximum session (D10).
- `<namespace>_auth_state`: `state`, the PKCE verifier and `return_to` between login and
  callback, HMAC-signed with the api secret key, 10 minutes, Path=/api/auth. Stateless replicas
  need nothing else.

Names come from the naming config, never a product literal (D14).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

from fastapi import Request, Response

from ..config import settings
from ..naming import naming

STATE_MAX_AGE_S = 600
STATE_PATH = "/api/auth"


def session_cookie_name() -> str:
    return f"{naming()['namespace']}_session"


def state_cookie_name() -> str:
    return f"{naming()['namespace']}_auth_state"


def _secure() -> bool:
    url = settings().public_url or settings().workos_redirect_uri or ""
    return not url.startswith("http://")


def read_session(request: Request) -> str | None:
    return request.cookies.get(session_cookie_name()) or None


def set_session(response: Response, sealed: str) -> None:
    response.set_cookie(session_cookie_name(), sealed, max_age=settings().session_max_hours * 3600, path="/", secure=_secure(), httponly=True, samesite="lax")


def clear_session(response: Response) -> None:
    response.delete_cookie(session_cookie_name(), path="/", secure=_secure(), httponly=True, samesite="lax")


# ---- Signed sign-in state ---------------------------------------------------------------------


def _mac(payload: bytes) -> str:
    key = hashlib.sha256(b"auth-state:" + settings().secret_key.encode()).digest()
    return base64.urlsafe_b64encode(hmac.new(key, payload, hashlib.sha256).digest()).rstrip(b"=").decode()


def sign_state(data: dict[str, Any]) -> str:
    payload = base64.urlsafe_b64encode(json.dumps({**data, "exp": int(time.time()) + STATE_MAX_AGE_S}, separators=(",", ":")).encode()).rstrip(b"=")
    return payload.decode() + "." + _mac(payload)


def verify_state(value: str | None) -> dict[str, Any] | None:
    """The state cookie's data, or None when it's missing, tampered with or expired."""
    if not value or "." not in value:
        return None
    payload, mac = value.rsplit(".", 1)
    if not hmac.compare_digest(mac, _mac(payload.encode())):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except ValueError:
        return None
    if not isinstance(data, dict) or int(data.get("exp", 0)) < time.time():
        return None
    return data


def set_state(response: Response, data: dict[str, Any]) -> None:
    response.set_cookie(state_cookie_name(), sign_state(data), max_age=STATE_MAX_AGE_S, path=STATE_PATH, secure=_secure(), httponly=True, samesite="lax")


def clear_state(response: Response) -> None:
    response.delete_cookie(state_cookie_name(), path=STATE_PATH, secure=_secure(), httponly=True, samesite="lax")
