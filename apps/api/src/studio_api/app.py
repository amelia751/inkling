"""FastAPI app factory: `uv run uvicorn studio_api.app:app --port 8000` (apps/api)."""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from studio_observability import RequestContextMiddleware, setup_service

from .config import SettingsError, env, settings
from .db import create_all, session_scope
from .naming import naming
from .routes import boots, boundary, environments, explore, files, kernel, ops, plugins, projects, sources, versioning, worker

log = logging.getLogger(__name__)


def _housekeeping(stop: threading.Event) -> None:
    """Event delivery and lease reaping that must not depend on a worker being up (KEDA may
    have scaled workers to zero). Every replica runs it; the bus's consumer group and the
    queue's reaper lock keep the work single."""
    from .kernel import eventbus, queue

    interval = settings().housekeeping_interval_s
    while not stop.wait(interval):
        try:
            with session_scope() as db:
                if settings().event_bus == "redis":
                    eventbus.deliver(db)
            if settings().job_queue == "redis":
                with session_scope() as db:
                    q = queue.backend()
                    if isinstance(q, queue.RedisJobQueue):
                        q.maybe_reap(db)
        except Exception:  # noqa: BLE001
            log.warning("housekeeping pass failed", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = threading.Event()
    t = None
    if settings().needs_redis and settings().housekeeping_interval_s > 0:
        t = threading.Thread(target=_housekeeping, args=(stop,), name="housekeeping", daemon=True)
        t.start()
    try:
        yield
    finally:
        stop.set()
        if t is not None:
            t.join(timeout=5)


def _seed_projects() -> None:
    """Every seed becomes a project, source, dataset and task (todo6 D2). Idempotent; a
    database that isn't migrated yet is retried on the first projects request."""
    from .kernel import projects as kprojects

    try:
        with session_scope() as db:
            kprojects.ensure_seeds(db)
    except Exception:  # noqa: BLE001
        log.warning("seed projects not upserted at startup", exc_info=True)


def create_app(*, init_db: bool = True) -> FastAPI:
    app = FastAPI(title=f"{naming()['displayName']} kernel", version=ops.service_version(), lifespan=lifespan)
    if init_db and settings().create_tables:
        create_all()
    if init_db:
        _seed_projects()
    app.include_router(ops.router)
    app.include_router(environments.router)
    app.include_router(kernel.router)
    app.include_router(plugins.router)
    app.include_router(worker.router)
    app.include_router(versioning.router)
    app.include_router(projects.router)
    app.include_router(boots.router)
    app.include_router(sources.router)
    app.include_router(files.router)
    app.include_router(explore.router)
    app.include_router(boundary.router)

    @app.get("/api/v1/health")
    def health():
        return {"ok": True}

    @app.middleware("http")
    async def correlation(request: Request, call_next):
        try:
            resp = await call_next(request)
        except Exception as e:  # noqa: BLE001 — the kernel never leaks a stack trace to plugins
            log.exception("unhandled error")
            return JSONResponse({"detail": f"internal error: {type(e).__name__}"}, status_code=500)
        cid = getattr(request.state, "ctx", None)
        if cid is not None:
            resp.headers["X-Correlation-Id"] = cid.correlation_id
        return resp

    # Outermost: request id (X-Request-Id, or the older X-Correlation-Id) and traceparent for
    # everything below, JSON access log without the probes.
    # Worker polls (every second per replica) are logged only when they fail.
    app.add_middleware(RequestContextMiddleware, quiet_when_ok=("/api/v1/worker/claim", "/api/v1/worker/events/deliver"))
    return app


def __getattr__(name: str):
    # `uvicorn studio_api.app:app` builds the app on first access, so importing this module
    # (tests, scripts) never touches the default database. Settings are validated here: a
    # bad configuration stops the process with the missing key names.
    if name == "app":
        global app
        setup_service(ops.SERVICE, ops.service_version(), level=env("LOG_LEVEL"), json_logs=env("LOG_FORMAT", "json") != "text")
        try:
            settings()
        except SettingsError as e:
            log.error(str(e), extra={"missing": e.missing, "invalid": e.invalid})
            raise SystemExit(2) from None
        app = create_app()
        return app
    raise AttributeError(name)
