"""Request ids and W3C trace context (https://www.w3.org/TR/trace-context/), per task/request.

Both live in context variables, so a log line, an outgoing HTTP call or a new job can pick
up the ids of the request (or job) that caused it without passing them around.
"""

from __future__ import annotations

import re
import secrets
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
_traceparent: ContextVar[str | None] = ContextVar("traceparent", default=None)

_TRACEPARENT = re.compile(r"^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")
_SAFE_ID = re.compile(r"[^A-Za-z0-9._:-]")


def new_request_id() -> str:
    return secrets.token_hex(16)


def clean_request_id(value: str | None) -> str | None:
    """An incoming X-Request-Id, made safe to log and store (64 chars, no control characters)."""
    if not value:
        return None
    v = _SAFE_ID.sub("", value.strip())[:64]
    return v or None


def parse_traceparent(value: str | None) -> tuple[str, str, str] | None:
    """(trace_id, parent span id, flags) of a valid version-00 header, else None."""
    if not value:
        return None
    m = _TRACEPARENT.match(value.strip().lower())
    if not m or m.group(1) == "0" * 32 or m.group(2) == "0" * 16:
        return None
    return m.group(1), m.group(2), m.group(3)


def child_traceparent(parent: str | None = None) -> str:
    """A traceparent for a new span: same trace as `parent` (if valid) with a fresh span id."""
    p = parse_traceparent(parent)
    trace_id, flags = (p[0], p[2]) if p else (secrets.token_hex(16), "01")
    return f"00-{trace_id}-{secrets.token_hex(8)}-{flags}"


def request_id() -> str | None:
    return _request_id.get()


def traceparent() -> str | None:
    """The current span's traceparent (OpenTelemetry's when it's active)."""
    from . import otel

    return otel.current_traceparent() or _traceparent.get()


_current_traceparent = traceparent


def trace_id() -> str | None:
    p = parse_traceparent(traceparent())
    return p[0] if p else None


def span_id() -> str | None:
    p = parse_traceparent(traceparent())
    return p[1] if p else None


def set_request_id(value: str | None):
    return _request_id.set(value)


def set_traceparent(value: str | None):
    return _traceparent.set(value)


@contextmanager
def bound(*, request_id: str | None = None, traceparent: str | None = None, name: str = "span", kind: str = "internal", attributes: dict | None = None) -> Iterator[None]:
    """Run a block (a request, a job) as a child span of `traceparent`, with this request id.

    With OpenTelemetry on, the span is a real one (exported); otherwise only the ids are
    carried, so logs and outgoing calls still share the trace id.
    """
    from . import otel

    parent = traceparent or _current_traceparent()
    with otel.span(name, parent, kind=kind, attributes=attributes) as real:
        t1 = _request_id.set(clean_request_id(request_id) or _request_id.get() or new_request_id())
        t2 = _traceparent.set(None if real else child_traceparent(parent))
        try:
            yield
        finally:
            _traceparent.reset(t2)
            _request_id.reset(t1)


def outgoing_headers() -> dict[str, str]:
    """Headers for a call to another service, so it continues this request's trace."""
    out: dict[str, str] = {}
    tp = traceparent()
    if tp:
        out["traceparent"] = tp
    rid = request_id()
    if rid:
        out["X-Request-Id"] = rid
    return out
