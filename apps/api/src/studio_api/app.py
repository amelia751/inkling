"""FastAPI app factory: `uv run uvicorn studio_api.app:app --port 8000` (apps/api)."""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse
from studio_observability import RequestContextMiddleware, setup_service
from studio_observability import request_id as obs_request_id

from .config import SettingsError, env, settings
from .db import session_scope
from .naming import naming
from .auth import routes as auth_routes
from .auth.session import session_middleware
from .kernel import service_scope
from .routes import audit as audit_routes
from .routes import changes as changes_routes
from .routes import connected_agents as connected_agents_routes
from .routes import me as me_routes
from .routes import org as org_routes
from .routes import org_security
from .routes import prefs as prefs_routes
from .routes import labels as labels_routes
from .routes import findings as findings_routes
from .routes import rules as rules_routes
from .routes import trash as trash_routes
from .routes import reviews as reviews_routes
from .routes import api_keys, boots, boundary, datasets_views, drops, environments, explore, features, files, kernel, ops, organize, pipelines, plugins, projects, service, sources, unpack, versioning, worker

log = logging.getLogger(__name__)


def _housekeeping(stop: threading.Event) -> None:
    """Event delivery and lease reaping that must not depend on a worker being up (KEDA may
    have scaled workers to zero). Every replica runs it; the bus's consumer group and the
    queue's reaper lock keep the work single."""
    import time

    from .kernel import drops, eventbus, imports, queue, sweepers

    interval = settings().housekeeping_interval_s
    stuck_checked = 0.0
    while not stop.wait(interval):
        try:
            # Drops stuck in `inspecting` (todo13 §7.3 alert), about once a minute.
            if time.monotonic() - stuck_checked >= 60:
                stuck_checked = time.monotonic()
                with session_scope() as db:
                    drops.log_stuck(db)
                    imports.fail_stalled(db)
                    sweepers.run(db)
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
    # The WorkOS Events API sync (todo9 Phase 7): workos mode only, one replica at a time.
    from .auth import sync as workos_sync

    sync_thread = workos_sync.start(stop)
    try:
        yield
    finally:
        stop.set()
        for th in (t, sync_thread):
            if th is not None:
                th.join(timeout=5)


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
    # A service principal's token reaches only its own routes (kernel/service_scope.py).
    app = FastAPI(title=f"{naming()['displayName']} kernel", version=ops.service_version(), lifespan=lifespan, dependencies=[Depends(service_scope.guard)])
    if init_db and settings().create_tables:
        from .devdb import migrate_dev

        migrate_dev()  # file SQLite: alembic upgrade head (todo18 P0-6); else create_all()
    if init_db:
        _seed_projects()
    from .kernel.admission import http as admission_http

    admission_http.install(app)  # problem JSON for rejected writes (todo17 D6)
    from .auth import oauth as oauth_auth
    from .auth import scopes as token_scopes

    token_scopes.install(app)  # 403 insufficient_scope (todo17 D12)
    oauth_auth.install(app)  # 202 + approval link for an outside agent's destroy (todo17 D12)
    app.include_router(ops.router)
    app.include_router(auth_routes.router)
    app.include_router(api_keys.router)
    app.include_router(environments.router)
    app.include_router(kernel.router)
    app.include_router(plugins.router)
    app.include_router(worker.router)
    app.include_router(worker.workers_router)
    app.include_router(versioning.router)
    app.include_router(projects.router)
    app.include_router(prefs_routes.router)
    app.include_router(datasets_views.router)
    app.include_router(boots.router)
    app.include_router(sources.router)
    app.include_router(rules_routes.router)
    app.include_router(labels_routes.router)
    app.include_router(findings_routes.router)
    app.include_router(changes_routes.router)
    app.include_router(reviews_routes.router)
    app.include_router(trash_routes.router)  # before files: it owns /trash now
    app.include_router(files.router)
    app.include_router(explore.router)
    app.include_router(boundary.router)
    app.include_router(service.router)
    app.include_router(pipelines.router)
    app.include_router(features.router)
    app.include_router(drops.router)
    app.include_router(organize.router)
    app.include_router(unpack.router)
    app.include_router(org_security.router)
    app.include_router(audit_routes.router)
    app.include_router(me_routes.router)
    app.include_router(connected_agents_routes.router)
    app.include_router(org_routes.router)

    @app.get("/api/v1/health")
    def health():
        return {"ok": True}

    # Innermost: the WorkOS session cookie (workos mode) → request.state.auth_session, refreshed
    # cookie written back, CSRF header checked (auth/session.py).
    app.middleware("http")(session_middleware)

    @app.middleware("http")
    async def correlation(request: Request, call_next):
        try:
            resp = await call_next(request)
        except Exception as e:  # noqa: BLE001 — the kernel never leaks a stack trace to plugins
            # Problem JSON with the request id only: never the exception text, which can carry
            # names, paths or values from the request (todo18 E P2).
            rid = obs_request_id() or request.headers.get("X-Request-Id") or ""
            log.exception("unhandled error", extra={"error_type": type(e).__name__, "request_id": rid})
            return JSONResponse(
                {"type": "/docs/errors#internal", "title": "Something went wrong on our side.", "status": 500, "code": "internal", "requestId": rid, "detail": f"internal error (request {rid})" if rid else "internal error", "retryable": True},
                status_code=500,
                media_type="application/problem+json",
                headers={"X-Request-Id": rid} if rid else None,
            )
        cid = getattr(request.state, "ctx", None)
        if cid is not None:
            resp.headers["X-Correlation-Id"] = cid.correlation_id
        return resp

    @app.middleware("http")
    async def agent_names(request: Request, call_next):
        """todo13 D13: an agent principal reads screened names only (kernel/agent_view.py)."""
        resp = await call_next(request)
        ctx = getattr(request.state, "ctx", None)
        if ctx is None or not ctx.principal.startswith("agent:") or not resp.headers.get("content-type", "").startswith("application/json"):
            return resp
        from starlette.responses import Response

        from .kernel import agent_view

        body = b"".join([chunk async for chunk in resp.body_iterator])  # type: ignore[attr-defined]
        route = request.scope.get("route")
        try:
            with session_scope() as db:
                body = agent_view.scrub_json_bytes(db, ctx.workspace_id, body, route_path=getattr(route, "path", None))
        except Exception:  # noqa: BLE001 — fail closed: an agent never gets an unscreened body
            log.exception("agent name screening failed")
            return JSONResponse({"detail": "this response couldn't be screened for the agent"}, status_code=503)
        headers = {k: v for k, v in resp.headers.items() if k.lower() not in ("content-length",)}
        return Response(body, status_code=resp.status_code, headers=headers, media_type="application/json")

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
