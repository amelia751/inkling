"""Per-job egress allowlist proxy (dev; production uses a network policy, docs/plugins.md §10).

A plugin process runs with HTTP(S)_PROXY pointing here. CONNECT (https) and absolute-URI
(http) requests reach only the kernel and the hosts the workspace granted this plugin
version (`network.egress:<host>`); everything else gets 403 and is recorded. Undeclared
egress fails closed (§14 #3).
"""

from __future__ import annotations

import select
import socket
import socketserver
import threading
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit


class EgressProxy:
    def __init__(self, allowed_hosts: set[str]):
        self.allowed = {h.lower() for h in allowed_hosts}
        self.denied: list[str] = []
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # quiet
                pass

            def _deny(self, host: str) -> None:
                proxy.denied.append(host)
                self.send_response(403, "egress not granted")
                self.send_header("Content-Length", "0")
                self.send_header("Connection", "close")
                self.end_headers()

            def do_CONNECT(self):  # noqa: N802
                host, _, port = self.path.partition(":")
                if host.lower() not in proxy.allowed:
                    return self._deny(host)
                try:
                    upstream = socket.create_connection((host, int(port or 443)), timeout=30)
                except OSError:
                    self.send_response(502)
                    self.end_headers()
                    return
                self.send_response(200, "Connection established")
                self.end_headers()
                self._pipe(self.connection, upstream)

            def _forward(self):
                u = urlsplit(self.path)
                host = (u.hostname or "").lower()
                if host not in proxy.allowed:
                    return self._deny(host)
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                try:
                    upstream = socket.create_connection((host, u.port or 80), timeout=30)
                except OSError:
                    self.send_response(502)
                    self.end_headers()
                    return
                path = u.path + (f"?{u.query}" if u.query else "")
                head = [f"{self.command} {path or '/'} HTTP/1.1"] + [f"{k}: {v}" for k, v in self.headers.items() if k.lower() not in ("proxy-connection", "connection")] + ["Connection: close", "", ""]
                upstream.sendall("\r\n".join(head).encode() + body)
                self._pipe(self.connection, upstream)

            do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _forward  # noqa: N815

            @staticmethod
            def _pipe(a: socket.socket, b: socket.socket) -> None:
                socks = [a, b]
                try:
                    while True:
                        r, _, _ = select.select(socks, [], [], 60)
                        if not r:
                            return
                        for s in r:
                            data = s.recv(65536)
                            if not data:
                                return
                            (b if s is a else a).sendall(data)
                finally:
                    b.close()

        class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
            daemon_threads = True
            allow_reuse_address = True

        self.server = Server(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> EgressProxy:
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.server.shutdown()
        self.server.server_close()
