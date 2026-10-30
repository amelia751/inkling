import { AsyncLocalStorage } from "node:async_hooks";

/** W3C trace context of the current unit of work (an HTTP request, a job, a run). */
export interface TraceContext {
  /** 32 lowercase hex chars. */
  traceId: string;
  /** This service's span: 16 lowercase hex chars. */
  spanId: string;
  /** The caller's span, when the trace came in on a `traceparent` header. */
  parentSpanId?: string;
  sampled: boolean;
}

export interface RequestContext {
  requestId?: string;
  trace?: TraceContext;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `ctx` as the current context; async work started inside inherits it. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}
