"""The worker's probe server (todo/done/todo3.md E.4): a few lines of stdlib HTTP on a side thread.

    GET /healthz → the process is up
    GET /readyz  → the kernel answers, and the worker isn't shutting down
    GET /version → {service, version, gitSha}
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx


class KernelProbe:
    """Is the kernel reachable? Cached briefly so probes don't hammer it."""

    def __init__(self, kernel_url: str, ttl_s: float = 5.0):
        self.kernel_url, self.ttl_s = kernel_url, ttl_s
        self._at, self._ok = 0.0, False
        self._lock = threading.Lock()

    def __call__(self) -> bool:
        with self._lock:
            if time.monotonic() - self._at < self.ttl_s:
                return self._ok
            ok = False
            for path in ("/healthz", "/api/v1/health"):
                try:
                    if httpx.get(self.kernel_url + path, timeout=2).status_code == 200:
                        ok = True
                        break
                except httpx.HTTPError:
                    pass
            self._at, self._ok = time.monotonic(), ok
            return ok


def serve(port: int, *, version: dict, ready: Callable[[], tuple[bool, dict]], host: str = "0.0.0.0") -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?")[0]
            if path == "/healthz":
                return self._send(200, {"status": "ok"})
            if path == "/readyz":
                ok, checks = ready()
                return self._send(200 if ok else 503, {"status": "ok" if ok else "unavailable", "checks": checks})
            if path == "/version":
                return self._send(200, version)
            self._send(404, {"error": "not found"})

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args) -> None:  # noqa: A002 — probes stay out of the logs
            pass

    class Server(ThreadingHTTPServer):
        def handle_error(self, request, client_address) -> None:  # a probe that hung up early isn't news
            pass

    server = Server((host, port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, name="health", daemon=True).start()
    return server
