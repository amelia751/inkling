"""The WorkOS client (todo9 Phase 3): one `AsyncWorkOSClient` per process, built from settings.

Nothing here reads the SDK's unprefixed `WORKOS_*` variables: every value is passed in from
`config.Settings` (`<envPrefix>API_WORKOS_*`). Tests swap the client with `set_client`.
"""

from __future__ import annotations

import logging
import time
from functools import lru_cache
from typing import Any

import httpx
from jwt import PyJWKClient

from ..config import settings

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.workos.com/"

_client: Any = None


def base_url() -> str:
    url = settings().workos_base_url or DEFAULT_BASE_URL
    return url if url.endswith("/") else url + "/"


def client() -> Any:
    """The process's `AsyncWorkOSClient` (workos mode only)."""
    global _client
    if _client is None:
        from workos import AsyncWorkOSClient

        s = settings()
        _client = AsyncWorkOSClient(api_key=s.workos_api_key, client_id=s.workos_client_id, base_url=base_url(), jwt_issuer=s.workos_issuer or None, jwt_leeway=5.0)
    return _client


def set_client(c: Any) -> None:
    """Tests: a fake with the same surface (`user_management`, `organizations`, …)."""
    global _client
    _client = c


def jwks_url() -> str:
    return f"{base_url()}sso/jwks/{settings().workos_client_id}"


@lru_cache(maxsize=4)
def _jwks(url: str) -> PyJWKClient:
    # PyJWKClient caches the key set (5 min) and refetches on an unknown `kid` (key rotation).
    return PyJWKClient(url, lifespan=300, timeout=5)


def signing_key(token: str) -> Any:
    """The public key that signed an access token. Raises `jwt.PyJWKClientError` when the key
    set can't be fetched (a transient failure: never sign anyone out for it)."""
    return _jwks(jwks_url()).get_signing_key_from_jwt(token).key


# ---- Readiness: is the key set reachable? Cached, so probes don't hit WorkOS each time. ---------

_ready: tuple[float, bool] = (0.0, False)
READY_TTL_OK_S = 300.0
READY_TTL_FAIL_S = 30.0


def jwks_ready() -> None:
    """For `/readyz` in workos mode: raises when the JWKS couldn't be fetched (cached result)."""
    global _ready
    at, ok = _ready
    age = time.monotonic() - at
    if at and age < (READY_TTL_OK_S if ok else READY_TTL_FAIL_S):
        if not ok:
            raise RuntimeError("WorkOS JWKS unreachable")
        return
    try:
        r = httpx.get(jwks_url(), timeout=3.0)
        r.raise_for_status()
        ok = bool(r.json().get("keys"))
    except Exception:  # noqa: BLE001
        ok = False
    _ready = (time.monotonic(), ok)
    if not ok:
        raise RuntimeError("WorkOS JWKS unreachable")


def reset() -> None:
    """Tests: forget the client, key sets and readiness."""
    global _client, _ready
    _client, _ready = None, (0.0, False)
    _jwks.cache_clear()
