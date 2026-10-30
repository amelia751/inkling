"""Shared service conventions for the Python apps (todo/todo3.md E.4).

    from studio_observability import setup_service, RequestContextMiddleware, outgoing_headers

- JSON logs on stdout with `service`, `version`, `request_id`, `trace_id` (`setup_logging`).
- Request ids (`X-Request-Id`, accepting the older `X-Correlation-Id`) and W3C `traceparent`
  carried in context variables; `outgoing_headers()` continues them on calls to other services.
- OpenTelemetry only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and the `otel` extra is installed.
"""

from __future__ import annotations

import os

from . import otel
from .asgi import QUIET_PATHS, RequestContextMiddleware
from .context import (
    bound,
    child_traceparent,
    clean_request_id,
    new_request_id,
    outgoing_headers,
    parse_traceparent,
    request_id,
    span_id,
    trace_id,
    traceparent,
)
from .logs import JsonFormatter, setup_logging


def setup_service(service: str, version: str, *, level: str | None = None, json_logs: bool | None = None) -> None:
    """Logging + (optional) tracing for a service process. `LOG_LEVEL` and `LOG_FORMAT=text`
    (unprefixed, like the OTEL_* variables) override the defaults."""
    lvl = level or os.environ.get("LOG_LEVEL") or "INFO"
    js = json_logs if json_logs is not None else os.environ.get("LOG_FORMAT", "json") != "text"
    setup_logging(service, version, lvl, json_logs=js)
    otel.setup(service, version)


def httpx_request_hook(request) -> None:  # noqa: ANN001 — duck-typed httpx.Request
    """`httpx.Client(event_hooks={"request": [httpx_request_hook]})`: every call carries the ids."""
    for k, v in outgoing_headers().items():
        if k not in request.headers:
            request.headers[k] = v


__all__ = [
    "QUIET_PATHS",
    "JsonFormatter",
    "RequestContextMiddleware",
    "bound",
    "child_traceparent",
    "clean_request_id",
    "httpx_request_hook",
    "new_request_id",
    "otel",
    "outgoing_headers",
    "parse_traceparent",
    "request_id",
    "setup_logging",
    "setup_service",
    "span_id",
    "trace_id",
    "traceparent",
]
