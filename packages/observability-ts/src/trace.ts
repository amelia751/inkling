import { randomBytes, randomUUID } from "node:crypto";
import type { RequestContext, TraceContext } from "./context.ts";

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

export const newTraceId = (): string => randomBytes(16).toString("hex");
export const newSpanId = (): string => randomBytes(8).toString("hex");

/** Parse a W3C `traceparent` header; undefined when absent or malformed (never throws). */
export function parseTraceparent(header: string | null | undefined): { traceId: string; spanId: string; sampled: boolean } | undefined {
  if (!header) return undefined;
  const m = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!m) return undefined;
  const [, version, traceId, spanId, flags] = m as unknown as [string, string, string, string, string];
  if (version === "ff" || traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  // Version 00 has exactly four fields; future versions may append more.
  if (version === "00" && header.trim().length !== 55) return undefined;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(t: Pick<TraceContext, "traceId" | "spanId" | "sampled">): string {
  return `00-${t.traceId}-${t.spanId}-${t.sampled ? "01" : "00"}`;
}

/** Continue the caller's trace (new span under theirs) or start a new sampled one. */
export function continueTrace(header: string | null | undefined): TraceContext {
  const parent = parseTraceparent(header);
  if (parent) return { traceId: parent.traceId, parentSpanId: parent.spanId, spanId: newSpanId(), sampled: parent.sampled };
  return { traceId: newTraceId(), spanId: newSpanId(), sampled: true };
}

/** A `traceparent` for an outgoing call: same trace, a fresh span id. */
export function childTraceparent(trace: TraceContext | undefined): string | undefined {
  return trace ? formatTraceparent({ ...trace, spanId: newSpanId() }) : undefined;
}

const REQUEST_ID = /^[A-Za-z0-9._:@/+=-]{1,128}$/;

/** Accept a caller's `X-Request-Id` when it is short and printable; otherwise mint one. */
export function requestIdFrom(header: string | null | undefined): string {
  return header && REQUEST_ID.test(header) ? header : randomUUID();
}

/** The context for an incoming request, from its headers. */
export function contextFromHeaders(get: (name: string) => string | null | undefined): RequestContext {
  return { requestId: requestIdFrom(get("x-request-id")), trace: continueTrace(get("traceparent")) };
}
