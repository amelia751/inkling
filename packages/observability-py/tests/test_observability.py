from __future__ import annotations

import asyncio
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from studio_observability import (
    JsonFormatter,
    RequestContextMiddleware,
    bound,
    child_traceparent,
    clean_request_id,
    otel,
    outgoing_headers,
    parse_traceparent,
    request_id,
    trace_id,
)

PARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


def test_traceparent_parsing_and_children():
    assert parse_traceparent(PARENT) == ("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", "01")
    for bad in (None, "", "garbage", "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "00-" + "0" * 32 + "-00f067aa0ba902b7-01"):
        assert parse_traceparent(bad) is None
    child = parse_traceparent(child_traceparent(PARENT))
    assert child and child[0] == PARENT.split("-")[1] and child[1] != PARENT.split("-")[2]
    assert parse_traceparent(child_traceparent(None)) is not None  # a new trace


def test_request_ids_are_sanitised():
    assert clean_request_id("abc-123") == "abc-123"
    assert clean_request_id("a\nb c<script>") == "abcscript"
    assert clean_request_id("x" * 200) == "x" * 64
    assert clean_request_id("\n\n") is None


def test_bound_nests_and_restores():
    assert request_id() is None and trace_id() is None
    with bound(request_id="r1", traceparent=PARENT):
        assert request_id() == "r1" and trace_id() == PARENT.split("-")[1]
        outer = outgoing_headers()["traceparent"]
        with bound():  # a child span of the current one, same request
            assert request_id() == "r1" and trace_id() == PARENT.split("-")[1]
            assert outgoing_headers()["traceparent"] != outer
        assert outgoing_headers() == {"traceparent": outer, "X-Request-Id": "r1"}
    assert request_id() is None


def test_middleware_sets_ids_and_logs_without_probes(caplog):
    seen = {}

    async def app(scope, receive, send):
        if scope["path"] == "/x":
            seen["rid"], seen["trace"] = request_id(), trace_id()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    mw = RequestContextMiddleware(app, quiet_when_ok=("/poll",))
    sent: list[dict] = []

    async def send(m):
        sent.append(m)

    async def receive():
        return {"type": "http.request"}

    def call(path: str, headers: list[tuple[bytes, bytes]]):
        sent.clear()
        asyncio.run(mw({"type": "http", "path": path, "method": "GET", "headers": headers}, receive, send))
        return dict(sent[0]["headers"])

    with caplog.at_level(logging.INFO, logger="access"):
        h = call("/x", [(b"x-request-id", b"abc"), (b"traceparent", PARENT.encode())])
        call("/healthz", [])
        call("/poll", [])
    assert h[b"x-request-id"] == b"abc" and seen["rid"] == "abc" and seen["trace"] == PARENT.split("-")[1]
    assert [r.getMessage() for r in caplog.records] == ["GET /x 200"]


def test_json_formatter_is_one_object_per_line():
    rec = logging.LogRecord("svc", logging.WARNING, __file__, 1, "x=%d", (1,), None)
    out = json.loads(JsonFormatter("worker", "0.1.0").format(rec))
    assert out["level"] == "warning" and out["msg"] == "x=1" and out["service"] == "worker" and "request_id" not in out


@pytest.fixture
def collector(monkeypatch):
    """A fake OTLP/HTTP endpoint that records what it receives."""
    got: list[bytes] = []

    class H(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            got.append(self.rfile.read(int(self.headers["Content-Length"] or 0)))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", f"http://127.0.0.1:{srv.server_address[1]}")
    yield got
    srv.shutdown()


def test_otel_exports_spans_that_continue_the_incoming_trace(collector):
    pytest.importorskip("opentelemetry.sdk")
    assert otel.setup("test-svc", "1.0")
    try:
        with bound(request_id="r", traceparent=PARENT, name="job x", kind="consumer"):
            tp = parse_traceparent(outgoing_headers()["traceparent"])
            assert tp and tp[0] == PARENT.split("-")[1]
    finally:
        otel.shutdown()
    body = b"".join(collector)
    assert bytes.fromhex(PARENT.split("-")[1]) in body and b"job x" in body and b"test-svc" in body


def test_otel_stays_off_without_an_endpoint(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", raising=False)
    assert not otel.setup("svc", "1") and not otel.enabled()


@pytest.mark.parametrize(
    ("env", "want"),
    [
        ({}, None),
        ({"OTEL_TRACES_EXPORTER": "console"}, "console"),
        ({"OTEL_TRACES_EXPORTER": "OTLP"}, "otlp"),
        ({"OTEL_TRACES_EXPORTER": "gcp"}, "gcp"),
        ({"OTEL_TRACES_EXPORTER": "gcp", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://x:4318"}, "gcp"),
        ({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://x:4318"}, "otlp"),
        ({"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://x:4318/v1/traces"}, "otlp"),
        ({"OTEL_TRACES_EXPORTER": "none", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://x:4318"}, None),
        ({"OTEL_TRACES_EXPORTER": "zipkin"}, None),
        ({"OTEL_TRACES_EXPORTER": ""}, None),
    ],
)
def test_exporter_for_follows_d4(env, want):
    assert otel.exporter_for(env) == want


def test_otel_off_logs_nothing(caplog):
    with caplog.at_level(logging.WARNING):
        assert not otel.setup("svc", "1", env={})
    assert not caplog.records


def test_otel_console_exporter_prints_spans(capsys):
    pytest.importorskip("opentelemetry.sdk")
    assert otel.setup("console-svc", "2.0", env={"OTEL_TRACES_EXPORTER": "console"})
    try:
        with otel.span("console job", PARENT, kind="consumer") as real:
            assert real
            assert otel.current_traceparent().split("-")[1] == PARENT.split("-")[1]
    finally:
        otel.shutdown()
    out = capsys.readouterr().out
    assert '"name": "console job"' in out and "console-svc" in out and PARENT.split("-")[1] in out


def test_otel_missing_packages_still_starts(monkeypatch, caplog):
    import builtins

    real_import = builtins.__import__

    def no_otel(name, *a, **k):
        if name.startswith("opentelemetry"):
            raise ImportError(name=name)
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", no_otel)
    monkeypatch.setattr(otel, "_warned", False)
    with caplog.at_level(logging.WARNING):
        assert not otel.setup("svc", "1", env={"OTEL_TRACES_EXPORTER": "gcp"})
        assert not otel.setup("svc", "1", env={"OTEL_TRACES_EXPORTER": "gcp"})
    assert len(caplog.records) == 1 and "otel extra" in caplog.records[0].getMessage()
    assert not otel.enabled()
