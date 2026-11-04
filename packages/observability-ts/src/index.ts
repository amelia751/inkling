/**
 * Shared observability conventions for the Node services (todo/done/todo3.md E.4):
 *
 * - `createServiceLogger`: pino JSON on stdout with `service`, `version`, `request_id`, `trace_id`.
 * - `contextFromHeaders` + `runWithContext`: per-request context (accepts `X-Request-Id` and W3C
 *   `traceparent`), carried through async work by AsyncLocalStorage.
 * - `installFetchPropagation`: outgoing `traceparent` / `x-request-id` to internal services.
 * - `initTracing`: optional OpenTelemetry export, only when OTEL_TRACES_EXPORTER (console, otlp, gcp)
 *   or OTEL_EXPORTER_OTLP_ENDPOINT is set and the SDK packages are installed (see otel.ts).
 *
 * Packages never import apps; framework glue (Hono middleware, routes) lives in each service.
 */
export { type RequestContext, type TraceContext, currentContext, runWithContext } from "./context.ts";
export { installFetchPropagation, sameOriginAs } from "./fetch.ts";
export { type Logger, type ServiceLoggerOptions, createServiceLogger } from "./logger.ts";
export { type TraceExporterKind, type Tracing, initTracing, otelTraceId, traceExporterFrom } from "./otel.ts";
export {
  childTraceparent,
  contextFromHeaders,
  continueTrace,
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
  requestIdFrom,
} from "./trace.ts";
