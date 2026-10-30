import { contextFromHeaders, runWithContext } from "@studio/observability-ts";
import type { Hono } from "hono";
import type { Logger } from "../log.ts";

export interface ServiceInfo {
  service: string;
  version: string;
  gitSha: string | undefined;
}

export interface Readiness {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

/** Probe and meta paths: unauthenticated and kept out of the access log. */
const QUIET = new Set(["/healthz", "/readyz", "/version", "/health/live", "/health/ready"]);

/**
 * Service conventions shared by every deployable (todo/done/todo3.md E.4). Register before any other
 * route: the request-context middleware must wrap them all.
 *
 * - `X-Request-Id` accepted (or minted) and echoed; W3C `traceparent` continued. Both land in every
 *   log line written while the request (or a run it started) is in flight.
 * - One JSON access-log line per request, except the probe paths above.
 * - GET /healthz (process up), /readyz (dependencies reachable and not draining), /version.
 */
export function registerServiceRoutes(app: Hono, deps: { log: Logger; info: ServiceInfo; readiness: () => Promise<Readiness> }): void {
  app.use("*", async (c, next) => {
    const ctx = contextFromHeaders((name) => c.req.header(name));
    c.header("X-Request-Id", ctx.requestId!);
    const started = performance.now();
    await runWithContext(ctx, () => next());
    if (QUIET.has(c.req.path)) return;
    runWithContext(ctx, () =>
      deps.log.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) }, "request"),
    );
  });

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    const r = await deps.readiness();
    return c.json(r, r.ok ? 200 : 503);
  });
  app.get("/version", (c) => c.json({ service: deps.info.service, version: deps.info.version, gitSha: deps.info.gitSha ?? null }));
}
