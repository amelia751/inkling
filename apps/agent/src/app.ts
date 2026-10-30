import { createReadStream, existsSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { PROFILES } from "./agent/profiles.ts";
import { SERVICE_NAME, SERVICE_VERSION } from "./cluster/naming.ts";
import type { Config } from "./config.ts";
import { streamRunEvents } from "./http/events.ts";
import { registerServiceRoutes } from "./http/service.ts";
import type { Logger } from "./log.ts";
import type { AgentStatus, CreateSessionResponse, ProfileName, SendMessageResponse } from "./protocol.ts";
import { sanitizeError } from "./runtime/events.ts";
import { HttpError, type SessionService } from "./runtime/sessions.ts";

export interface ReadyCheck {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export interface AppDeps {
  config: Config;
  sessions: SessionService;
  log: Logger;
  /** Cached readiness (Daytona reachability, egress tier); never called on the liveness path. */
  ready?: () => Promise<ReadyCheck>;
}

const clientToolSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(8000),
  input_schema: z.record(z.string(), z.unknown()),
  title: z.string().max(80).optional(),
});

const snapshotSchema = z.object({
  project: z.object({
    id: z.string(),
    title: z.string(),
    viewer: z.string(),
    task: z.string().optional(),
    labels: z.array(z.string()),
    license: z.string(),
    source: z.string(),
    restricted: z.boolean(),
  }),
  items: z.array(
    z.object({ id: z.string(), name: z.string(), group: z.string(), sourceLabel: z.string().optional(), assets: z.array(z.string()).optional() }),
  ),
  annotations: z.array(
    z.object({
      id: z.string(),
      itemId: z.string(),
      label: z.string(),
      type: z.string(),
      provenance: z.enum(["human-created", "ai-suggested", "human-corrected"]),
      summary: z.string(),
    }),
  ),
  currentItemId: z.string().optional(),
  selectedIds: z.array(z.string()),
  tools: z.array(z.string()),
  unsavedChanges: z.boolean(),
});

const schemas = {
  createSession: z.object({
    projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "projectId must be a slug"),
    profile: z.enum(Object.keys(PROFILES) as [ProfileName, ...ProfileName[]]).optional(),
    clientTools: z.array(clientToolSchema).max(64).optional(),
    catalogPrompt: z.string().max(200_000).optional(),
    restricted: z.boolean().optional(),
  }),
  message: z.object({ text: z.string().min(1).max(32_000), context: z.string().max(200_000).optional(), snapshot: snapshotSchema.optional() }),
  clientTool: z.object({ ok: z.boolean(), output: z.unknown() }),
  approval: z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(2000).optional() }),
};

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Private HTTP API (todo1 §6). Every /v1 route needs the service bearer token (probes and /version don't); the
 * Vite proxy (dev) or apps/api (prod) adds it, so the browser never holds it.
 */
export function createApp({ config, sessions, log, ready }: AppDeps): Hono {
  const app = new Hono();

  registerServiceRoutes(app, {
    log,
    info: { service: SERVICE_NAME, version: SERVICE_VERSION, gitSha: config.gitSha },
    readiness: () => sessions.cluster.readiness(),
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    log.error({ err: sanitizeError(String(err?.stack ?? err)), path: c.req.path }, "unhandled error");
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health/live", (c) => c.json({ ok: true }));
  app.get("/health/ready", async (c) => {
    const r = ready ? await ready() : { ok: true, checks: {} };
    return c.json(r, r.ok ? 200 : 503);
  });

  app.use("/v1/*", async (c, next) => {
    if (!config.serviceToken || !tokenMatches(c.req.header("authorization"), config.serviceToken)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.use("/v1/*", bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: "body too large" }, 413) }));

  app.get("/v1/status", (c) => {
    const status: AgentStatus = {
      configured: config.model.provider === "scripted" || !!config.providerKeys[config.model.provider],
      provider: config.model.provider,
      model: config.model.id,
      sandbox: sessions.sandboxes ? "daytona" : "off",
      profiles: (Object.keys(PROFILES) as ProfileName[]).filter((p) => !PROFILES[p].sandbox || !!sessions.sandboxes),
    };
    return c.json(status);
  });

  app.post("/v1/sessions", async (c) => {
    const req = await body(c, schemas.createSession);
    const ctx = await sessions.create(req);
    const res: CreateSessionResponse = { sessionId: ctx.id, profile: ctx.meta.profile, model: `${config.model.provider}:${config.model.id}` };
    return c.json(res, 201);
  });

  app.get("/v1/sessions/:id", async (c) => c.json(await sessions.describe(await sessions.get(c.req.param("id")))));

  app.delete("/v1/sessions/:id", async (c) => {
    await sessions.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/v1/sessions/:id/messages", async (c) => {
    const ctx = await sessions.get(c.req.param("id"));
    const { run, steered } = await sessions.send(ctx, await body(c, schemas.message));
    const res: SendMessageResponse = { runId: run.id, steered };
    return c.json(res, 202);
  });

  app.get("/v1/runs/:runId/events", async (c) => {
    const runId = c.req.param("runId");
    const run = await sessions.lookupRun(runId);
    const fromHeader = Number(c.req.header("last-event-id"));
    const fromQuery = Number(c.req.query("after"));
    const after = Math.max(Number.isFinite(fromHeader) ? fromHeader : 0, Number.isFinite(fromQuery) ? fromQuery : 0);
    return streamRunEvents(c, { bus: sessions.cluster.bus, run, after, lookup: () => sessions.lookupRun(runId) });
  });

  app.post("/v1/runs/:runId/cancel", async (c) => {
    const run = await sessions.cancel(c.req.param("runId"));
    return c.json({ runId: run.id, status: run.status });
  });

  app.post("/v1/runs/:runId/client-tools/:callId", async (c) => {
    const accepted = await sessions.answerClientTool(c.req.param("runId"), c.req.param("callId"), await body(c, schemas.clientTool));
    return accepted ? c.json({ ok: true }) : c.json({ error: "no pending call with that id (already answered, timed out or cancelled)" }, 409);
  });

  app.post("/v1/approvals/:approvalId", async (c) => {
    const accepted = await sessions.decideApproval(c.req.param("approvalId"), await body(c, schemas.approval));
    return accepted ? c.json({ ok: true }) : c.json({ error: "no pending approval with that id" }, 404);
  });

  app.get("/v1/sessions/:id/artifacts", async (c) => c.json((await sessions.get(c.req.param("id"))).info().artifacts));

  app.get("/v1/artifacts/:artifactId", async (c) => {
    if (config.env === "production") return c.json({ error: "artifact downloads use signed object-store URLs in production" }, 404);
    const a = await sessions.findArtifact(c.req.param("artifactId"));
    if (!a || !existsSync(a.hostPath)) return c.json({ error: "no such artifact" }, 404);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Length", String(statSync(a.hostPath).size));
    c.header("Content-Disposition", `attachment; filename="${a.name.replace(/"/g, "")}"`);
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(Readable.toWeb(createReadStream(a.hostPath)) as ReadableStream);
  });

  return app;
}
