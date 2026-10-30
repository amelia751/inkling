import { hostname } from "node:os";
import { pino } from "pino";
import { currentContext } from "./context.ts";
import { otelTraceId } from "./otel.ts";

export type Logger = pino.Logger;

export interface ServiceLoggerOptions {
  /** Stable, brand-free service name, e.g. "agent". */
  service: string;
  version: string;
  level?: string;
  /** Extra fields on every line (e.g. `git_sha`). */
  base?: Record<string, unknown>;
  /** pino redact paths; matched values become "[redacted]". */
  redact?: string[];
  /** Defaults to stdout. Tests pass a stream. */
  destination?: pino.DestinationStream;
}

/**
 * One JSON object per line on stdout with `service`, `version`, `level` (as a name), ISO `time`,
 * and, inside a request or run, `request_id` and `trace_id` (from AsyncLocalStorage, or the active
 * OpenTelemetry span when tracing is on). No log files.
 */
export function createServiceLogger(o: ServiceLoggerOptions): Logger {
  return pino(
    {
      level: o.level ?? "info",
      base: { service: o.service, version: o.version, host: hostname(), ...o.base },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: o.redact?.length ? { paths: o.redact, censor: "[redacted]" } : undefined,
      mixin() {
        const ctx = currentContext();
        const traceId = otelTraceId() ?? ctx?.trace?.traceId;
        const out: Record<string, string> = {};
        if (ctx?.requestId) out.request_id = ctx.requestId;
        if (traceId) out.trace_id = traceId;
        return out;
      },
    },
    o.destination,
  );
}
