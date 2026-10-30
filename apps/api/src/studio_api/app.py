"""FastAPI app factory: `uv run uvicorn studio_api.app:app --port 8000` (apps/api)."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .db import create_all
from .naming import naming
from .routes import kernel, plugins, worker


def create_app(*, init_db: bool = True) -> FastAPI:
    app = FastAPI(title=f"{naming()['displayName']} kernel", version="0.1.0")
    if init_db:
        create_all()
    app.include_router(kernel.router)
    app.include_router(plugins.router)
    app.include_router(worker.router)

    @app.get("/api/v1/health")
    def health():
        return {"ok": True}

    @app.middleware("http")
    async def correlation(request: Request, call_next):
        try:
            resp = await call_next(request)
        except Exception as e:  # noqa: BLE001 — the kernel never leaks a stack trace to plugins
            return JSONResponse({"detail": f"internal error: {type(e).__name__}"}, status_code=500)
        cid = getattr(request.state, "ctx", None)
        if cid is not None:
            resp.headers["X-Correlation-Id"] = cid.correlation_id
        return resp

    return app


def __getattr__(name: str):
    # `uvicorn studio_api.app:app` builds the app on first access, so importing this module
    # (tests, scripts) never touches the default database.
    if name == "app":
        global app
        app = create_app()
        return app
    raise AttributeError(name)
