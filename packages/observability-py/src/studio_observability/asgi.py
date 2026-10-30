"""ASGI middleware: request id + trace context per request, and one access-log line each.

Pure ASGI (not BaseHTTPMiddleware), so streaming responses aren't buffered. Probe paths
(`/healthz`, `/readyz`, `/version`) are served without an access-log line.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterable

from . import context

access_log = logging.getLogger("access")

QUIET_PATHS = ("/healthz", "/readyz", "/version")


class RequestContextMiddleware:
    def __init__(self, app, quiet_paths: Iterable[str] = QUIET_PATHS, quiet_when_ok: Iterable[str] = ()):
        """`quiet_paths` never get an access-log line; `quiet_when_ok` (polling endpoints) only on errors."""
        self.app = app
        self.quiet = set(quiet_paths)
        self.quiet_ok = set(quiet_when_ok)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}
        rid = context.clean_request_id(headers.get("x-request-id")) or context.clean_request_id(headers.get("x-correlation-id")) or context.new_request_id()
        parent = headers.get("traceparent")
        path, method = scope.get("path", ""), scope.get("method", "")
        status = {"code": 500}

        async def send_with_ids(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                names = {k.lower() for k, _ in message.get("headers") or []}
                extra = [(b"x-request-id", rid.encode())] if b"x-request-id" not in names else []
                message = {**message, "headers": [*(message.get("headers") or []), *extra]}
            await send(message)

        start = time.perf_counter()
        with context.bound(request_id=rid, traceparent=parent, name=f"{method} {path}", kind="server", attributes={"http.request.method": method, "url.path": path}):
            try:
                await self.app(scope, receive, send_with_ids)
            finally:
                if path not in self.quiet and not (path in self.quiet_ok and status["code"] < 400):
                    access_log.info(
                        f"{method} {path} {status['code']}",
                        extra={"http_method": method, "http_path": path, "http_status": status["code"], "duration_ms": round((time.perf_counter() - start) * 1000, 1)},
                    )
