import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { PROFILES, profileAvailable } from "./agent/profiles.ts";
import { SERVICE_NAME, SERVICE_VERSION } from "./cluster/naming.ts";
import type { Config } from "./config.ts";
import { type AccessTokenVerifier, type AppEnv, authenticate, serviceOnly, workosVerifier } from "./http/auth.ts";
import { streamRunEvents } from "./http/events.ts";
import { registerServiceRoutes } from "./http/service.ts";
import type { Logger } from "./log.ts";
import type { AgentStatus, CreateSessionResponse, ProfileName, SendMessageResponse, ThreadResponse } from "@studio/agent-protocol";
import { sanitizeError } from "./runtime/events.ts";
import { HttpError, SESSION_ID, type SessionService } from "./runtime/sessions.ts";

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
  /** WorkOS access-token verification (`workos` auth mode); built from config when omitted. Tests pass a fake JWKS. */
  verifier?: AccessTokenVerifier;
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
    z.object({ id: z.string(), name: z.string(), group: z.string(), sourceLabel: z.string().optional(), assets: z.array(z.string()).optional(), kind: z.string().max(200).optional() }),
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

const sessionFields = {
  projectId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "projectId must be a slug"),
  profile: z.enum(Object.keys(PROFILES) as [ProfileName, ...ProfileName[]]).optional(),
  clientTools: z.array(clientToolSchema).max(64).optional(),
  catalogPrompt: z.string().max(200_000).optional(),
  restricted: z.boolean().optional(),
};

const schemas = {
  createSession: z.object({
    ...sessionFields,
    kernelToken: z.string().min(16).max(512).optional(),
    // todo20 W3: the conversation id is the session id.
    sessionId: z.string().regex(SESSION_ID, "sessionId must look like ses_… or conv-…").optional(),
  }),
  message: z
    .object({
      // todo20 W3: create-on-first-use when the session in the path doesn't exist yet.
      session: z.object(sessionFields).optional(),
      text: z.string().max(32_000),
      context: z.string().max(200_000).optional(),
      snapshot: snapshotSchema.optional(),
      kernelToken: z.string().min(16).max(512).optional(),
      // todo13: a drop alone is a message too.
      drop: z.object({ dropId: z.string().regex(/^drp-[a-z0-9]{8,40}$/, "dropId must look like drp-…") }).optional(),
    })
    .refine((m) => m.text.length > 0 || !!m.drop, { message: "text must not be empty (unless the message carries a drop)", path: ["text"] }),
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

const ORG_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const PRINCIPAL = /^user:[A-Za-z0-9_.@-]{1,200}$/;

function internalParam(value: string, pattern: RegExp, name: string): string {
  if (!pattern.test(value)) throw new HttpError(400, `${name} is malformed`);
  return value;
}

/**
 * Private HTTP API (todo1 §6). Every /v1 route needs the service token (probes and /version don't); the
 * Vite proxy (dev) or the web nginx adds it, so the browser never holds it. In `workos` auth mode the
 * proxies also forward the person's WorkOS access token and every session is theirs (http/auth.ts).
 */
export function createApp({ config, sessions, log, ready, verifier }: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const verify = verifier ?? (config.auth.mode === "workos" ? workosVerifier(config.auth) : undefined);

  registerServiceRoutes(app, {
    log,
    info: { service: SERVICE_NAME, version: SERVICE_VERSION, gitSha: config.gitSha },
    readiness: () => sessions.cluster.readiness(),
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(err.code ? { error: err.code, message: err.message } : { error: err.message }, err.status as 400);
    log.error({ err: sanitizeError(String(err?.stack ?? err)), path: c.req.path }, "unhandled error");
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health/live", (c) => c.json({ ok: true }));
  app.get("/health/ready", async (c) => {
    const r = ready ? await ready() : { ok: true, checks: {} };
    return c.json(r, r.ok ? 200 : 503);
  });

  app.use("/v1/*", authenticate(config, verify, log));
  app.use("/v1/*", bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: "body too large" }, 413) }));

  app.use("/v1/internal/*", serviceOnly(config));

  // todo14 D9: the API deletes an organization's conversations (org deleted) or one member's there
  // (member removed). Service token only; the browser proxies never forward /v1/internal.
  app.delete("/v1/internal/orgs/:orgId/sessions", async (c) => {
    const orgId = internalParam(c.req.param("orgId"), ORG_ID, "orgId");
    return c.json({ deleted: await sessions.deleteForOrg(orgId) });
  });

  app.delete("/v1/internal/orgs/:orgId/members/:principal/sessions", async (c) => {
    const orgId = internalParam(c.req.param("orgId"), ORG_ID, "orgId");
    const principal = internalParam(c.req.param("principal"), PRINCIPAL, "principal");
    return c.json({ deleted: await sessions.deleteForOrg(orgId, principal) });
  });

  app.get("/v1/status", (c) => {
    const status: AgentStatus = {
      configured: config.model.provider === "scripted" || !!config.providerKeys[config.model.provider],
      provider: config.model.provider,
      model: config.model.id,
      sandbox: sessions.sandboxes?.provider.kind ?? "off",
      profiles: (Object.keys(PROFILES) as ProfileName[]).filter((p) => profileAvailable(PROFILES[p], !!sessions.sandboxes)),
    };
    return c.json(status);
  });

  app.post("/v1/sessions", async (c) => {
    const req = await body(c, schemas.createSession);
    const { principal, orgId } = c.get("caller");
    const ctx = await sessions.create(req, principal, orgId);
    const res: CreateSessionResponse = {
      sessionId: ctx.id,
      profile: ctx.meta.profile,
      model: `${config.model.provider}:${config.model.id}`,
      session: await sessions.summarize(ctx.meta),
    };
    return c.json(res, 201);
  });

  // The caller's conversations in their current organization (todo9 Phase 5, todo14 §4), newest first.
  app.get("/v1/sessions", async (c) => {
    const { principal, orgId } = c.get("caller");
    return c.json({ sessions: await sessions.list(principal, orgId, c.req.query("projectId") || undefined) });
  });

  app.get("/v1/sessions/:id", async (c) => {
    const { principal, orgId } = c.get("caller");
    return c.json(await sessions.describe(await sessions.get(c.req.param("id"), principal, orgId)));
  });

  // todo20 W3: the visible thread, rebuilt from the transcript and the session's runs.
  app.get("/v1/sessions/:id/thread", async (c) => {
    const { principal, orgId } = c.get("caller");
    const res: ThreadResponse = await sessions.thread(await sessions.get(c.req.param("id"), principal, orgId));
    return c.json(res);
  });

  app.delete("/v1/sessions/:id", async (c) => {
    const { principal, orgId } = c.get("caller");
    await sessions.delete(c.req.param("id"), principal, orgId);
    return c.body(null, 204);
  });

  app.post("/v1/sessions/:id/messages", async (c) => {
    const { principal, orgId } = c.get("caller");
    const id = c.req.param("id");
    const req = await body(c, schemas.message);
    const ctx = await sessions.get(id, principal, orgId).catch(async (err) => {
      // todo20 W3: a conversation the browser named but never created (or one from before W3).
      if (!(err instanceof HttpError) || err.status !== 404 || !req.session || !SESSION_ID.test(id)) throw err;
      return sessions.create({ ...req.session, sessionId: id, kernelToken: req.kernelToken }, principal, orgId);
    });
    const { run, steered } = await sessions.send(ctx, req);
    const res: SendMessageResponse = { runId: run.id, steered };
    return c.json(res, 202);
  });

  app.get("/v1/runs/:runId/events", async (c) => {
    const runId = c.req.param("runId");
    const run = await sessions.lookupRun(runId, c.get("caller").principal);
    const fromHeader = Number(c.req.header("last-event-id"));
    const fromQuery = Number(c.req.query("after"));
    const after = Math.max(Number.isFinite(fromHeader) ? fromHeader : 0, Number.isFinite(fromQuery) ? fromQuery : 0);
    return streamRunEvents(c, { bus: sessions.cluster.bus, run, after, lookup: () => sessions.lookupRun(runId) });
  });

  app.post("/v1/runs/:runId/cancel", async (c) => {
    const run = await sessions.cancel(c.req.param("runId"), c.get("caller").principal);
    return c.json({ runId: run.id, status: run.status });
  });

  app.post("/v1/runs/:runId/client-tools/:callId", async (c) => {
    const accepted = await sessions.answerClientTool(c.req.param("runId"), c.req.param("callId"), await body(c, schemas.clientTool), c.get("caller").principal);
    return accepted ? c.json({ ok: true }) : c.json({ error: "no pending call with that id (already answered, timed out or cancelled)" }, 409);
  });

  app.post("/v1/approvals/:approvalId", async (c) => {
    const accepted = await sessions.decideApproval(c.req.param("approvalId"), await body(c, schemas.approval), c.get("caller").principal);
    return accepted ? c.json({ ok: true }) : c.json({ error: "no pending approval with that id" }, 404);
  });

  app.get("/v1/sessions/:id/artifacts", async (c) => {
    const { principal, orgId } = c.get("caller");
    return c.json((await sessions.get(c.req.param("id"), principal, orgId)).info().artifacts);
  });

  app.get("/v1/artifacts/:artifactId", async (c) => {
    if (config.env === "production") return c.json({ error: "artifact downloads use signed object-store URLs in production" }, 404);
    const a = await sessions.findArtifact(c.req.param("artifactId"), c.get("caller").principal);
    if (!a || !existsSync(a.hostPath)) return c.json({ error: "no such artifact" }, 404);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Length", String(statSync(a.hostPath).size));
    c.header("Content-Disposition", `attachment; filename="${a.name.replace(/"/g, "")}"`);
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(Readable.toWeb(createReadStream(a.hostPath)) as ReadableStream);
  });

  return app;
}
