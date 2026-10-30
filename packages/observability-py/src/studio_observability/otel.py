"""Optional OpenTelemetry: on only when OTEL_EXPORTER_OTLP_ENDPOINT is set and the `otel`
extra is installed. Everything here is a no-op otherwise, so services never depend on it.

The exporter reads the standard OTEL_* variables (endpoint, headers, protocol, sampler).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

log = logging.getLogger(__name__)

_tracer: Any = None


def enabled() -> bool:
    return _tracer is not None


def setup(service: str, version: str) -> bool:
    """Install a tracer provider exporting OTLP/HTTP. Returns whether tracing is on."""
    global _tracer
    if _tracer is not None:
        return True
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") and not os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"):
        return False
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        log.warning("OTEL_EXPORTER_OTLP_ENDPOINT is set but the otel extra isn't installed; tracing stays off")
        return False
    attrs = {"service.name": os.environ.get("OTEL_SERVICE_NAME") or service, "service.version": version}
    provider = TracerProvider(resource=Resource.create(attrs))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    _tracer = trace.get_tracer(service, version)
    return True


def shutdown() -> None:
    global _tracer
    if _tracer is None:
        return
    from opentelemetry import trace

    provider = trace.get_tracer_provider()
    if hasattr(provider, "shutdown"):
        provider.shutdown()  # type: ignore[union-attr]
    _tracer = None


def current_traceparent() -> str | None:
    if _tracer is None:
        return None
    from opentelemetry import trace

    sc = trace.get_current_span().get_span_context()
    if not sc.is_valid:
        return None
    return f"00-{sc.trace_id:032x}-{sc.span_id:016x}-{int(sc.trace_flags):02x}"


@contextmanager
def span(name: str, parent_traceparent: str | None, kind: str = "internal", attributes: dict | None = None) -> Iterator[bool]:
    """A span continuing `parent_traceparent`. Yields whether a real OTel span is active."""
    if _tracer is None:
        yield False
        return
    from opentelemetry import trace
    from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

    ctx = TraceContextTextMapPropagator().extract({"traceparent": parent_traceparent} if parent_traceparent else {})
    k = {"server": trace.SpanKind.SERVER, "client": trace.SpanKind.CLIENT, "consumer": trace.SpanKind.CONSUMER}.get(kind, trace.SpanKind.INTERNAL)
    with _tracer.start_as_current_span(name, context=ctx, kind=k, attributes=attributes or {}) as s:
        try:
            yield True
        except Exception as e:
            s.record_exception(e)
            s.set_status(trace.Status(trace.StatusCode.ERROR))
            raise
