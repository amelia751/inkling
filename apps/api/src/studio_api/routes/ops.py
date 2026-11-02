"""Service conventions (todo/done/todo3.md E.4): unauthenticated probes, never in the access log.

    GET /healthz → the process is up (liveness)
    GET /readyz  → DB, Redis (when a backend uses it), the BlobStore and (workos mode) the WorkOS
                   key set answer (readiness)
    GET /version → {service, version, gitSha}
"""

from __future__ import annotations

import logging
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as pkg_version

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .. import blobstore, redis_client
from ..config import settings
from ..db import engine

log = logging.getLogger(__name__)
router = APIRouter()

SERVICE = "api"


def service_version() -> str:
    try:
        return pkg_version("studio-api")
    except PackageNotFoundError:
        return "0.0.0"


def checks() -> dict[str, str]:
    """Each dependency → "ok" or the exception type (never a message: it may hold a URL)."""
    out: dict[str, str] = {}

    def run(name: str, fn) -> None:
        try:
            fn()
            out[name] = "ok"
        except Exception as e:  # noqa: BLE001
            log.warning("readiness check %s failed: %s", name, type(e).__name__)
            out[name] = f"error: {type(e).__name__}"

    def db() -> None:
        with engine().connect() as c:
            c.execute(text("SELECT 1"))

    run("database", db)
    if settings().redis_url or settings().needs_redis:
        run("redis", lambda: redis_client.client().ping())
    run("blobstore", lambda: (blobstore.assets().ping(), blobstore.data().ping()))
    if settings().workos:
        from ..auth import client as workos_client

        # Cached (5 min when up, 30 s when down): probes never hammer WorkOS.
        run("workos_jwks", workos_client.jwks_ready)
    return out


@router.get("/healthz", include_in_schema=False)
def healthz():
    return {"status": "ok"}


@router.get("/readyz", include_in_schema=False)
def readyz():
    c = checks()
    ok = all(v == "ok" for v in c.values())
    return JSONResponse({"status": "ok" if ok else "unavailable", "checks": c}, status_code=200 if ok else 503)


@router.get("/version", include_in_schema=False)
def version():
    return {"service": SERVICE, "version": service_version(), "gitSha": settings().git_sha}
