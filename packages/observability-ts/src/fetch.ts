import { currentContext } from "./context.ts";
import { childTraceparent } from "./trace.ts";

/**
 * Wrap `globalThis.fetch` so calls to our own services carry the current `traceparent` (a child
 * span of the current trace) and `x-request-id`. Only URLs for which `shouldPropagate` is true get
 * the headers (internal services, never model providers or other third parties); headers the
 * caller already set win. Returns an uninstall function.
 */
export function installFetchPropagation(shouldPropagate: (url: URL) => boolean): () => void {
  const original = globalThis.fetch;
  const wrapped = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const ctx = currentContext();
    if (!ctx?.trace && !ctx?.requestId) return original(input, init);
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return original(input, init);
    }
    if (!shouldPropagate(url)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const tp = childTraceparent(ctx.trace);
    if (tp && !headers.has("traceparent")) headers.set("traceparent", tp);
    if (ctx.requestId && !headers.has("x-request-id")) headers.set("x-request-id", ctx.requestId);
    return original(input, { ...init, headers });
  };
  globalThis.fetch = wrapped as typeof fetch;
  return () => {
    if (globalThis.fetch === (wrapped as typeof fetch)) globalThis.fetch = original;
  };
}

/** `shouldPropagate` for a fixed list of base URLs (same origin). Invalid or empty entries are ignored. */
export function sameOriginAs(baseUrls: (string | undefined)[]): (url: URL) => boolean {
  const origins = new Set(
    baseUrls.flatMap((u) => {
      try {
        return u ? [new URL(u).origin] : [];
      } catch {
        return [];
      }
    }),
  );
  return (url) => origins.has(url.origin);
}
