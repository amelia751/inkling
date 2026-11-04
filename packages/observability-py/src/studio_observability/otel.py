"""Optional OpenTelemetry (todo/todo27.md D4). One switch: tracing is on when
OTEL_TRACES_EXPORTER is `console`, `otlp` or `gcp`, or when an OTLP endpoint is set. Unset means
off, with no cost and no warnings. `gcp` exports to Cloud Trace with application default
credentials (the service account on GKE). Everything here is a no-op when tracing is off or the
`otel` extra isn't installed, so services never depend on it.

The SDK reads the other standard OTEL_* variables itself (endpoint, headers, protocol, and the
sampler from OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG).
"""

from __future__ import annotations

import logging
import os
import re
import sys
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import Any, Literal

log = logging.getLogger(__name__)

Exporter = Literal["console", "otlp", "gcp"]
EXPORTERS: tuple[Exporter, ...] = ("console", "otlp", "gcp")

_tracer: Any = None
_provider: Any = None
_warned = False


def enabled() -> bool:
    return _tracer is not None


def exporter_for(env: Mapping[str, str]) -> Exporter | None:
    """Which exporter D4 picks for these variables, or None when tracing is off."""
    kind = env.get("OTEL_TRACES_EXPORTER", "").strip().lower()
    if kind in EXPORTERS:
        return kind  # type: ignore[return-value]
    if kind:  # `none`, or a value we don't support: off
        return None
    if env.get("OTEL_EXPORTER_OTLP_ENDPOINT") or env.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"):
        return "otlp"
    return None


def _warn_once(msg: str, *args: object) -> None:
    global _warned
    if not _warned:
        _warned = True
        log.warning(msg, *args)


_KEEP_SEGMENT = re.compile(r"^(v\d+|[a-z][a-z_-]{0,31}|\{[a-z_]+\})$")
_URL_KEYS = ("url.full", "url.path", "http.url", "http.target")
_DROP_KEYS = ("url.query",)
_NAMED_REQUEST = re.compile(r"^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (/\S*)$")


def redact_path(path: str) -> str:
    """D3: request paths carry ids and file names. Keep route words (`api`, `v1`, `jobs`,
    `{job_id}`); every other segment becomes `{id}`; the query string is dropped."""
    path = path.split("?", 1)[0].split("#", 1)[0]
    return "/".join(seg if (not seg or _KEEP_SEGMENT.match(seg)) else "{id}" for seg in path.split("/"))


def redact_url(value: str) -> str:
    if value.startswith("/"):
        return redact_path(value)
    m = re.match(r"^([a-z][a-z0-9+.-]*://[^/?#]*)(.*)$", value, re.I)
    return (m.group(1) + redact_path(m.group(2) or "/")) if m else redact_path(value)


def redact_span_fields(name: str, attributes: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """The span name and attributes with every request path redacted (pure; tested)."""
    out = {k: (redact_url(v) if k in _URL_KEYS and isinstance(v, str) else v) for k, v in attributes.items() if k not in _DROP_KEYS}
    m = _NAMED_REQUEST.match(name)
    return (f"{m.group(1)} {redact_path(m.group(2))}" if m else name), out


class _Redacting:
    """Wraps an exporter: spans leave the process with their request paths redacted (D3)."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner

    def export(self, spans: Any) -> Any:
        from opentelemetry.sdk.trace import ReadableSpan

        out = []
        for s in spans:
            name, attrs = redact_span_fields(s.name, dict(s.attributes or {}))
            out.append(ReadableSpan(name=name, context=s.context, parent=s.parent, resource=s.resource, attributes=attrs, events=s.events, links=s.links, kind=s.kind, status=s.status, start_time=s.start_time, end_time=s.end_time, instrumentation_scope=s.instrumentation_scope))
        return self.inner.export(out)

    def shutdown(self) -> None:
        self.inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self.inner.force_flush(timeout_millis)


def _span_processor(kind: Exporter) -> Any:
    from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter, SimpleSpanProcessor

    if kind == "console":
        return SimpleSpanProcessor(_Redacting(ConsoleSpanExporter(out=sys.stdout)))
    if kind == "gcp":
        from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter

        return BatchSpanProcessor(_Redacting(CloudTraceSpanExporter()))
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

    return BatchSpanProcessor(_Redacting(OTLPSpanExporter()))


def setup(service: str, version: str, env: Mapping[str, str] | None = None) -> bool:
    """Install a tracer provider for the exporter D4 picks. Returns whether tracing is on."""
    global _tracer, _provider
    if _tracer is not None:
        return True
    env = os.environ if env is None else env
    raw = env.get("OTEL_TRACES_EXPORTER", "").strip().lower()
    kind = exporter_for(env)
    if kind is None:
        if raw and raw != "none":
            _warn_once("OTEL_TRACES_EXPORTER=%s isn't one of console, otlp, gcp; tracing stays off", raw)
        return False
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider

        processor = _span_processor(kind)
    except ImportError as e:
        _warn_once("tracing is on (%s exporter) but the otel extra isn't installed (%s); tracing stays off", kind, e.name)
        return False
    except Exception as e:  # e.g. no application default credentials for gcp
        _warn_once("tracing is on (%s exporter) but the exporter failed to start (%s); tracing stays off", kind, e)
        return False
    attrs = {"service.name": env.get("OTEL_SERVICE_NAME") or service, "service.version": version}
    provider = TracerProvider(resource=Resource.create(attrs))  # sampler from OTEL_TRACES_SAMPLER
    provider.add_span_processor(processor)
    trace.set_tracer_provider(provider)
    _provider, _tracer = provider, provider.get_tracer(service, version)
    return True


def shutdown() -> None:
    global _tracer, _provider
    if _provider is not None:
        _provider.shutdown()
    _tracer = _provider = None


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
