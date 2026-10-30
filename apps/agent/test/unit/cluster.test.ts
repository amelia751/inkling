/**
 * Two (three) app instances sharing one Postgres and one Redis, as replicas behind a plain Service:
 * a run started on A is streamed, resumed (Last-Event-ID), approved and answered on B; a follow-up
 * turn on B is seen by A; cancel crosses replicas; a replica that stops heartbeating has its run
 * marked interrupted on the next read and the user resumes elsewhere.
 *
 * Runs only with AGENT_TEST_DATABASE_URL and AGENT_TEST_REDIS_URL, e.g.
 *   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17
 *   docker run -d --rm -p 56379:6379 redis:7
 *   AGENT_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres AGENT_TEST_REDIS_URL=redis://127.0.0.1:56379 pnpm agent:test
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createModelRuntime, registerScriptedProvider } from "../../src/agent/models.ts";
import { createApp } from "../../src/app.ts";
import { RedisRunEventBus } from "../../src/bus/redis.ts";
import { INTERRUPTED_MESSAGE } from "../../src/cluster/coordinator.ts";
import { loadConfig } from "../../src/config.ts";
import { createLogger } from "../../src/log.ts";
import type { AgentEvent } from "../../src/protocol.ts";
import { SessionService } from "../../src/runtime/sessions.ts";
import { PostgresSessionStore } from "../../src/store/postgres.ts";
import { ENV_TOOLS, TOKEN, snapshot } from "./harness.ts";

const DB = process.env.AGENT_TEST_DATABASE_URL;
const REDIS = process.env.AGENT_TEST_REDIS_URL;
const schema = `agent_cluster_${randomUUID().slice(0, 8)}`;
const prefix = `agentcluster${randomUUID().slice(0, 8)}`;

const FIXTURE = {
  scripts: [
    { when: "run beats", turns: [{ toolCalls: [{ name: "run_command", arguments: { id: "timeseries.commands.detectBeats" } }] }, { text: "Command finished." }] },
    { when: "overview", turns: [{ toolCalls: [{ name: "dataset_overview" }] }, { text: "Two items." }] },
    { when: "wait", turns: [{ toolCalls: [{ name: "get_environment" }] }, { text: "never" }] },
  ],
};

async function instance(replica: string) {
  const dir = mkdtempSync(join(tmpdir(), `agent-${replica}-`));
  const { config } = loadConfig({
    APP_ENV: "test",
    AGENT_MODEL: "scripted",
    AGENT_DATA_DIR: dir,
    INTERNAL_AGENT_SERVICE_TOKEN: TOKEN,
    AGENT_STUDIO_URL: "http://127.0.0.1:9",
    AGENT_STORE: "postgres",
    AGENT_DATABASE_URL: DB!,
    AGENT_DATABASE_SCHEMA: schema,
    AGENT_EVENT_BUS: "redis",
    AGENT_REDIS_URL: REDIS!,
    AGENT_REPLICA_ID: replica,
    AGENT_RUN_LEASE_S: "2",
    AGENT_RUN_HEARTBEAT_S: "1",
    AGENT_INBOX_POLL_MS: "200",
    AGENT_CLIENT_TOOL_TIMEOUT_S: "60",
  });
  const runtime = await createModelRuntime(config);
  registerScriptedProvider(runtime, FIXTURE);
  const log = createLogger("silent");
  const store = new PostgresSessionStore(DB!, { schema, autoMigrate: true });
  await store.init();
  const bus = new RedisRunEventBus(REDIS!, { prefix, maxLen: 2000, ttlS: 600, blockMs: 250 });
  await bus.init();
  const sessions = new SessionService({ config, runtime, log, store, bus });
  const app = createApp({ config, sessions, log });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  /** Read the SSE stream (resuming with Last-Event-ID), letting `onEvent` act, until done or `until`. */
  async function drive(runId: string, onEvent: (e: AgentEvent) => void | Promise<void> = () => {}, lastEventId = 0, until?: (e: AgentEvent) => boolean) {
    const res = await call("GET", `/v1/runs/${runId}/events`, undefined, lastEventId ? { "last-event-id": String(lastEventId) } : {});
    if (res.status !== 200 || !res.body) throw new Error(`events ${res.status}`);
    const events: AgentEvent[] = [];
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return events;
        buf += value;
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          const e = JSON.parse(data) as AgentEvent;
          events.push(e);
          await onEvent(e);
          if (e.type === "done" || until?.(e)) return events;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  return {
    replica,
    sessions,
    store,
    call,
    json,
    drive,
    async close() {
      await sessions.shutdown();
      await bus.close();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Instance = Awaited<ReturnType<typeof instance>>;
const instances: Instance[] = [];
const start = async (replica: string) => {
  const i = await instance(replica);
  instances.push(i);
  return i;
};
const seqs = (events: AgentEvent[]) => events.map((e) => e.seq);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newSession(i: Instance) {
  const res = await i.json("POST", "/v1/sessions", { projectId: "demo", profile: "environment-designer", clientTools: ENV_TOOLS });
  expect(res.status).toBe(201);
  return res.body.sessionId as string;
}

describe.skipIf(!DB || !REDIS)("replicas sharing Postgres + Redis", () => {
  afterAll(async () => {
    for (const i of instances) await i.close().catch(() => {});
    const pool = new pg.Pool({ connectionString: DB });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    const r = new Redis(REDIS!);
    const keys = await r.keys(`${prefix}:*`);
    if (keys.length) await r.del(...keys);
    await r.quit();
  });

  it("a run on A is streamed, resumed, approved and answered on B; B's next turn is visible on A", { timeout: 30_000 }, async () => {
    const a = await start("replica-a");
    const b = await start("replica-b");
    const sid = await newSession(a);
    const runId = (await a.json("POST", `/v1/sessions/${sid}/messages`, { text: "run beats" })).body.runId as string;

    // B sees the session (built from Postgres) and its active run, though the loop is on A.
    const info = await b.json("GET", `/v1/sessions/${sid}`);
    expect(info.body).toMatchObject({ sessionId: sid, activeRunId: runId });

    const head = await b.drive(runId, () => {}, 0, (e) => e.type === "approval");
    const approval = head.at(-1) as Extract<AgentEvent, { type: "approval" }>;
    expect(approval).toMatchObject({ type: "approval", toolName: "run_command" });

    // Approve on B; A (which runs the loop) learns of it. A second decision anywhere is a 404.
    expect((await b.json("POST", `/v1/approvals/${approval.approvalId}`, { decision: "approve" })).status).toBe(200);
    expect((await a.json("POST", `/v1/approvals/${approval.approvalId}`, { decision: "approve" })).status).toBe(404);

    // Resume on B from the approval with Last-Event-ID; answer the client tool on B too.
    const answered: number[] = [];
    const tail = await b.drive(
      runId,
      async (e) => {
        if (e.type !== "client-tool") return;
        answered.push((await b.json("POST", `/v1/runs/${runId}/client-tools/${e.callId}`, { ok: true, output: { handled: true } })).status);
        answered.push((await a.json("POST", `/v1/runs/${runId}/client-tools/${e.callId}`, { ok: true, output: { handled: true } })).status);
      },
      approval.seq,
    );
    expect(answered).toEqual([200, 409]);
    expect(tail[0]!.seq).toBe(approval.seq + 1);
    expect(tail.find((e) => e.type === "approval-resolved")).toMatchObject({ decision: "approve" });
    expect(tail.find((e) => e.type === "tool-result")).toMatchObject({ ok: true });
    expect(tail.at(-1)).toMatchObject({ type: "done", status: "completed" });

    // A full replay from A is the same stream, seq 1..n.
    const all = await a.drive(runId);
    expect(seqs(all)).toEqual(all.map((_, i) => i + 1));
    expect(seqs([...head, ...tail])).toEqual(seqs(all));
    expect(await a.store.getRun(runId)).toMatchObject({ status: "completed", replica: "replica-a" });

    // The next turn lands on B and runs there; A notices its cached session is stale and reloads.
    const next = (await b.json("POST", `/v1/sessions/${sid}/messages`, { text: "overview", snapshot: snapshot() })).body;
    expect(next.steered).toBe(false);
    expect((await a.drive(next.runId)).at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(await b.store.getRun(next.runId)).toMatchObject({ status: "completed", replica: "replica-b" });
    const onA = await a.sessions.get(sid);
    const onB = await b.sessions.get(sid);
    expect(onA.piSession.messages.length).toBe(onB.piSession.messages.length);
    expect(JSON.stringify(onA.piSession.messages)).toContain("Two items.");
  });

  it("cancel and steer cross replicas", { timeout: 30_000 }, async () => {
    const [a, b] = instances;
    const sid = await newSession(a!);
    const runId = (await a!.json("POST", `/v1/sessions/${sid}/messages`, { text: "wait" })).body.runId as string;
    let callId = "";
    await b!.drive(runId, (e) => void (e.type === "client-tool" && (callId = e.callId)), 0, (e) => e.type === "client-tool");
    // A message sent to B while A runs the loop is steered into A's run.
    expect((await b!.json("POST", `/v1/sessions/${sid}/messages`, { text: "and also" })).body).toEqual({ runId, steered: true });
    expect((await b!.json("POST", `/v1/runs/${runId}/cancel`)).status).toBe(200);
    const events = await b!.drive(runId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
    expect((await b!.json("POST", `/v1/runs/${runId}/client-tools/${callId}`, { ok: true, output: {} })).status).toBe(409);
  });

  it("a replica that stops heartbeating has its run interrupted on the next read; the user resumes elsewhere", { timeout: 30_000 }, async () => {
    const b = instances[1]!;
    const c = await start("replica-c");
    const sid = await newSession(c);
    const runId = (await c.json("POST", `/v1/sessions/${sid}/messages`, { text: "wait" })).body.runId as string;
    const head = await b.drive(runId, () => {}, 0, (e) => e.type === "client-tool");
    // "Kill" C: its heartbeat and inbox stop (the process would be gone).
    c.sessions.cluster.stop();
    await sleep(3000);
    const tail = await b.drive(runId, () => {}, head.at(-1)!.seq);
    expect(tail.map((e) => (e.type === "error" ? e.message : e.type === "done" ? e.status : e.type))).toEqual([INTERRUPTED_MESSAGE, "failed"]);
    expect((await b.store.getRun(runId))?.status).toBe("interrupted");
    expect((await b.json("GET", `/v1/sessions/${sid}`)).body.activeRunId).toBeUndefined();
    // Resume: the next message starts a new run on B from the stored transcript.
    const next = (await b.json("POST", `/v1/sessions/${sid}/messages`, { text: "overview", snapshot: snapshot() })).body;
    expect(next.steered).toBe(false);
    expect((await b.drive(next.runId)).at(-1)).toMatchObject({ type: "done", status: "completed" });
  });
});
