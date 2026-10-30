import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createModelRuntime } from "./agent/models.ts";
import { isProfileName } from "./agent/profiles.ts";
import { type Config, describeSecrets, loadConfig } from "./config.ts";
import type { AgentStatus } from "./protocol.ts";
import { SandboxDisabledError, createDaytona } from "./sandbox/client.ts";
import { SandboxManager } from "./sandbox/manager.ts";
import { getSnapshotStatus } from "./sandbox/snapshot.ts";
import { reclaimForQuota, runSweep } from "./sandbox/sweeper.ts";
import { SessionLimitError, SessionRegistry } from "./runtime/sessions.ts";
import { ensureDevServiceToken, loadDevSecrets } from "./secrets.ts";
import { ClientToolError } from "./tools/client.ts";

const log = (msg: string) => console.log(`[agent] ${msg}`);

const createSession = z.object({
  projectId: z.string().min(1).max(128),
  profile: z.string().refine(isProfileName, "unknown profile"),
  clientTools: z
    .array(z.object({ name: z.string(), description: z.string(), input_schema: z.record(z.string(), z.unknown()) }))
    .max(64)
    .optional(),
  catalogPrompt: z.string().max(64_000).optional(),
  restricted: z.boolean().optional(),
});
const sendMessage = z.object({ text: z.string().min(1).max(32_000), context: z.string().max(200_000).optional() });
const clientToolResult = z.object({ ok: z.boolean(), output: z.unknown() });
const approvalDecision = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().max(2000).optional() });

function bearerOk(header: string | undefined, token: string | undefined): boolean {
  if (!token) return false;
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function buildApp(config: Config) {
  const runtime = await createModelRuntime(config);
  const daytona = createDaytona(config);
  let registry!: SessionRegistry;
  const sandboxes = daytona
    ? new SandboxManager(daytona, config, {
        warn: log,
        reclaim: () => reclaimForQuota(daytona, config.env, registry.activeSessionIds(), log),
      })
    : undefined;
  registry = new SessionRegistry({ config, runtime, sandboxes, log });
  const owner = "local";

  let ready: { at: number; body: Record<string, unknown> } | undefined;
  const status: AgentStatus = {
    configured: Boolean(config.providerKeys[config.model.provider]),
    provider: config.model.provider,
    model: config.model.id,
    sandbox: daytona ? "daytona" : "off",
  };

  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof ClientToolError || err instanceof SessionLimitError) return c.json({ error: err.message }, 400);
    if (err instanceof SandboxDisabledError) return c.json({ error: err.message }, 503);
    log(`error: ${err.message}`);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health/live", (c) => c.json({ ok: true }));
  app.get("/health/ready", async (c) => {
    if (!ready || Date.now() - ready.at > 60_000) {
      let sandbox: unknown = "off";
      if (daytona) {
        sandbox = await getSnapshotStatus(daytona).then(
          (s) => ({ reachable: true, snapshot: s.state }),
          (e) => ({ reachable: false, error: (e as Error).message }),
        );
      }
      ready = { at: Date.now(), body: { ok: status.configured, model: `${status.provider}:${status.model}`, sandbox } };
    }
    return c.json(ready.body, ready.body.ok ? 200 : 503);
  });

  app.use("/v1/*", async (c, next) => {
    if (!bearerOk(c.req.header("authorization"), config.serviceToken)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.get("/v1/status", (c) => c.json(status));

  app.post("/v1/sessions", async (c) => {
    const body = createSession.parse(await c.req.json());
    const s = await registry.create(body as Parameters<SessionRegistry["create"]>[0], owner);
    return c.json({ sessionId: s.id }, 201);
  });

  const session = (id: string) => {
    const s = registry.get(id);
    return s && s.owner === owner ? s : undefined;
  };

  app.get("/v1/sessions/:id", (c) => {
    const s = session(c.req.param("id"));
    return s ? c.json(registry.info(s)) : c.json({ error: "not found" }, 404);
  });

  app.delete("/v1/sessions/:id", async (c) => {
    const s = session(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    await registry.delete(s.id);
    return c.body(null, 204);
  });

  app.post("/v1/sessions/:id/messages", async (c) => {
    const s = session(c.req.param("id"));
    if (!s) return c.json({ error: "not found" }, 404);
    const { text, context } = sendMessage.parse(await c.req.json());
    const { run, steered } = await registry.send(s, text, context);
    return c.json({ runId: run.id, ...(steered ? { steered } : {}) }, 202);
  });

  app.get("/v1/runs/:runId/events", (c) => {
    const found = registry.findRun(c.req.param("runId"));
    if (!found || found.session.owner !== owner) return c.json({ error: "not found" }, 404);
    const { run } = found;
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      const queue = run.events.after(after);
      let wake: (() => void) | undefined;
      const unsubscribe = run.events.subscribe((e) => {
        queue.push(e);
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      try {
        for (;;) {
          while (queue.length) {
            const e = queue.shift()!;
            await stream.writeSSE({ id: String(e.seq), data: JSON.stringify(e) });
            if (e.type === "done") return;
          }
          if (stream.aborted) return;
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 15_000);
          });
          wake = undefined;
          if (!queue.length && !stream.aborted) await stream.write(": keepalive\n\n");
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.post("/v1/runs/:runId/cancel", async (c) => {
    const found = registry.findRun(c.req.param("runId"));
    if (!found || found.session.owner !== owner) return c.json({ error: "not found" }, 404);
    await registry.cancel(found.session, found.run);
    return c.json({ status: found.run.status });
  });

  app.post("/v1/runs/:runId/client-tools/:callId", async (c) => {
    const found = registry.findRun(c.req.param("runId"));
    if (!found || found.session.owner !== owner) return c.json({ error: "not found" }, 404);
    const body = clientToolResult.parse(await c.req.json());
    const ok = found.session.bridge.answer(c.req.param("callId"), { ok: body.ok, output: body.output });
    return ok ? c.json({ ok: true }) : c.json({ error: "no pending call" }, 409);
  });

  app.post("/v1/approvals/:approvalId", async (c) => {
    const body = approvalDecision.parse(await c.req.json());
    const id = c.req.param("approvalId");
    for (const sid of registry.ids()) {
      const s = session(sid);
      if (s?.approvals.decide(id, body)) return c.json({ ok: true });
    }
    return c.json({ error: "no pending approval" }, 409);
  });

  app.get("/v1/sessions/:id/artifacts", (c) => {
    const s = session(c.req.param("id"));
    return s ? c.json(registry.info(s).artifacts) : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/artifacts/:artifactId", (c) => {
    if (config.env === "production") return c.json({ error: "not available" }, 404);
    for (const sid of registry.ids()) {
      const a = session(sid)?.artifacts.find((x) => x.id === c.req.param("artifactId"));
      if (a && existsSync(a.hostPath)) {
        return new Response(Readable.toWeb(createReadStream(a.hostPath)) as ReadableStream, {
          headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${a.name.replace(/"/g, "")}"` },
        });
      }
    }
    return c.json({ error: "not found" }, 404);
  });

  const sweep = daytona
    ? async () => {
        const r = await runSweep(
          daytona,
          {
            env: config.env,
            activeSessions: registry.activeSessionIds(),
            knownSessions: registry.ids(),
            idleStopMin: 30,
            retentionDays: Math.ceil(config.sandbox.autoDeleteMin / (60 * 24)),
            maxDeletes: 5,
          },
          { log },
        ).catch((e) => log(`sweep failed: ${(e as Error).message}`));
        return r;
      }
    : undefined;

  return { app, registry, sweep };
}

async function main() {
  const loaded = loadDevSecrets();
  ensureDevServiceToken();
  const { config, warnings } = loadConfig();
  log(`env=${config.env} model=${config.model.provider}:${config.model.id} loaded=${loaded.length} secrets: ${describeSecrets(config)}`);
  for (const w of warnings) log(`warning: ${w}`);
  const { app, sweep } = await buildApp(config);
  if (sweep) {
    void sweep();
    setInterval(() => void sweep(), 10 * 60 * 1000).unref();
  }
  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => log(`listening on http://${info.address}:${info.port}`));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
