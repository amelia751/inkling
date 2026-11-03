import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileSessionStore } from "../../src/store/file.ts";
import { MIGRATIONS, migrate, schemaVersion } from "../../src/store/migrations.ts";
import { PostgresSessionStore } from "../../src/store/postgres.ts";
import type { RunRecord, SessionStore, StoredMeta } from "../../src/store/types.ts";

const PG = process.env.AGENT_TEST_DATABASE_URL;

const sid = () => `ses_${randomUUID()}`;
const rid = () => `run_${randomUUID()}`;
const meta = (id = sid(), owner = "local"): StoredMeta => ({ id, owner, projectId: "demo", profile: "assistant", artifacts: [] });
const run = (sessionId: string, replica = "r1", id = rid()): RunRecord => {
  const now = Date.now();
  return { id, sessionId, owner: "local", status: "queued", replica, createdAt: now, updatedAt: now, heartbeatAt: now };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The behaviour every store must have; run against the file store always and Postgres when configured. */
function contract(name: string, make: () => Promise<SessionStore>, cleanup: () => Promise<void> = async () => {}) {
  describe(`SessionStore contract: ${name}`, () => {
    let s: SessionStore;
    beforeAll(async () => {
      s = await make();
    });
    afterAll(async () => {
      await s.close();
      await cleanup();
    });

    it("stores, lists, counts and deletes sessions", async () => {
      const m = meta();
      await s.putMeta(m);
      await s.putMeta({ ...m, sandboxId: "sb-1" });
      expect(await s.getMeta(m.id)).toMatchObject({ id: m.id, owner: "local", sandboxId: "sb-1" });
      expect((await s.listSessionIds()).has(m.id)).toBe(true);
      expect(await s.countSessions()).toBeGreaterThanOrEqual(1);
      await s.appendTranscript(m.id, 0, [{ type: "session", id: "h" }]);
      await s.insertRun(run(m.id));
      await s.deleteSession(m.id);
      expect(await s.getMeta(m.id)).toBeUndefined();
      expect(await s.readTranscript(m.id)).toEqual([]);
      expect(await s.activeRunForSession(m.id)).toBeUndefined();
    });

    it("lists sessions by owner and organization (todo9 Phase 5)", async () => {
      const u = `user:${randomUUID()}`;
      const a = { ...meta(sid(), u), orgId: "org_a" };
      const b = { ...meta(sid(), u), orgId: "org_b" };
      const other = { ...meta(sid(), `user:${randomUUID()}`), orgId: "org_a" };
      const noOrg = meta(sid(), u);
      for (const m of [a, b, other, noOrg]) await s.putMeta(m);
      const ids = async (orgId: string | undefined, projectId?: string) => (await s.listSessions({ owner: u, orgId, projectId })).map((m) => m.id);
      expect(await ids("org_a")).toEqual([a.id]);
      expect(await ids("org_b")).toEqual([b.id]);
      expect(await ids(undefined)).toEqual([noOrg.id]);
      expect(await ids("org_a", "elsewhere")).toEqual([]);
      for (const m of [a, b, other, noOrg]) await s.deleteSession(m.id);
    });

    it("lists an organization's sessions, or one member's there, and their runs (todo14 D9)", async () => {
      const org = `org_${randomUUID()}`;
      const other = `org_${randomUUID()}`;
      const u1 = `user:${randomUUID()}`;
      const u2 = `user:${randomUUID()}`;
      const a = { ...meta(sid(), u1), orgId: org };
      const b = { ...meta(sid(), u2), orgId: org };
      const c = { ...meta(sid(), u1), orgId: other };
      const d = meta(sid(), u1);
      for (const m of [a, b, c, d]) await s.putMeta(m);
      const ra = run(a.id);
      const rb = run(b.id);
      const rc = run(c.id);
      for (const r of [ra, rb, rc]) await s.insertRun(r);
      const ids = async (f: { orgId: string; owner?: string }) => (await s.listOrgSessions(f)).map((m) => m.id).sort();
      expect(await ids({ orgId: org })).toEqual([a.id, b.id].sort());
      expect(await ids({ orgId: org, owner: u1 })).toEqual([a.id]);
      expect(await ids({ orgId: org, owner: `user:${randomUUID()}` })).toEqual([]);
      expect((await s.runIdsForSessions([a.id, b.id])).sort()).toEqual([ra.id, rb.id].sort());
      expect(await s.runIdsForSessions([])).toEqual([]);
      for (const m of [a, b, c, d]) await s.deleteSession(m.id);
      expect(await s.getRun(ra.id)).toBeUndefined();
      expect(await s.runIdsForSessions([a.id, b.id, c.id])).toEqual([]);
    });

    it("records thread parts per session, one per key, replaced in place (todo22 W4)", async () => {
      const m = meta();
      await s.putMeta({ ...m, notes: ["undid a change"], lastOpenedAt: new Date().toISOString() });
      expect(await s.getMeta(m.id)).toMatchObject({ notes: ["undid a change"] });
      const r = run(m.id);
      await s.insertRun(r);
      await s.putUiPart({ sessionId: m.id, runId: r.id, messageId: "msg-1", partKey: "card:c1", part: { type: "card", id: "c1", state: "open" } });
      await s.putUiPart({ sessionId: m.id, runId: null, messageId: "msg-1", partKey: "boot:b1", part: { type: "boot", id: "b1" } });
      await s.putUiPart({ sessionId: m.id, runId: null, messageId: "msg-1", partKey: "card:c1", part: { type: "card", id: "c1", state: "applied" } });
      const parts = await s.listUiParts(m.id);
      expect(parts.map((p) => [p.partKey, p.runId, p.part.state])).toEqual([
        ["card:c1", r.id, "applied"],
        ["boot:b1", null, undefined],
      ]);
      await s.deleteSession(m.id);
      expect(await s.listUiParts(m.id)).toEqual([]);
    });

    it("keeps the transcript in order, header first", async () => {
      const m = meta();
      await s.putMeta(m);
      await s.appendTranscript(m.id, 0, [{ type: "session" }, { n: 1 }]);
      await s.appendTranscript(m.id, 2, [{ n: 2 }, { n: 3, text: "nul \u0000 ok" }]);
      expect(await s.readTranscript(m.id)).toEqual([{ type: "session" }, { n: 1 }, { n: 2 }, { n: 3, text: "nul \u0000 ok" }]);
    });

    it("allows one active run per session; terminal states are final", async () => {
      const m = meta();
      await s.putMeta(m);
      const r1 = run(m.id);
      expect(await s.insertRun(r1)).toBe(true);
      expect(await s.insertRun(run(m.id, "r2"))).toBe(false);
      expect((await s.activeRunForSession(m.id))?.id).toBe(r1.id);
      expect((await s.activeSessionIds()).has(m.id)).toBe(true);
      await s.updateRun(r1.id, { status: "running" });
      await s.updateRun(r1.id, { status: "completed", usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, costUsd: 0.5 }, toolCalls: 3 });
      await s.updateRun(r1.id, { status: "running" });
      expect(await s.getRun(r1.id)).toMatchObject({ status: "completed", usage: { costUsd: 0.5 }, toolCalls: 3 });
      expect(await s.insertRun(run(m.id, "r2"))).toBe(true);
    });

    it("heartbeats report runs a replica no longer owns; stale runs are interrupted once", async () => {
      const m = meta();
      await s.putMeta(m);
      const r = run(m.id, "r1");
      await s.insertRun(r);
      expect(await s.heartbeat([r.id, "run_missing"], "r1")).toEqual(["run_missing"]);
      expect(await s.heartbeat([r.id], "r2")).toEqual([r.id]);
      expect(await s.interruptIfStale(r.id, 60_000)).toBe(false);
      s.openInput({ id: `${r.id}:c1`, runId: r.id, sessionId: m.id, owner: "local", kind: "client-tool" });
      await sleep(80);
      expect(await s.interruptIfStale(r.id, 20)).toBe(true);
      expect(await s.interruptIfStale(r.id, 20)).toBe(false);
      expect((await s.getRun(r.id))?.status).toBe("interrupted");
      // Inputs of an interrupted run can't be answered any more.
      expect(await s.answerInput(`${r.id}:c1`, "client-tool", "local", { ok: true })).toBeUndefined();
      expect(await s.heartbeat([r.id], "r1")).toEqual([r.id]);
    });

    it("run inputs: answered once, by the owner, delivered once", async () => {
      const m = meta();
      await s.putMeta(m);
      const r = run(m.id);
      await s.insertRun(r);
      await s.openInput({ id: "apr_1" + r.id, runId: r.id, sessionId: m.id, owner: "local", kind: "approval" });
      expect(await s.answerInput("apr_1" + r.id, "approval", "mallory", { decision: "approve" })).toBeUndefined();
      expect(await s.answerInput("apr_1" + r.id, "client-tool", "local", { decision: "approve" })).toBeUndefined();
      expect(await s.answerInput("apr_1" + r.id, "approval", "local", { decision: "approve" })).toMatchObject({ runId: r.id, state: "answered" });
      expect(await s.answerInput("apr_1" + r.id, "approval", "local", { decision: "reject" })).toBeUndefined();
      await s.pushCommand({ id: `cmd_${randomUUID()}`, runId: r.id, sessionId: m.id, owner: "local", kind: "steer", payload: { text: "also this" } });
      const taken = await s.takeAnswered([r.id]);
      expect(taken.map((i) => [i.kind, i.payload])).toEqual([
        ["approval", { decision: "approve" }],
        ["steer", { text: "also this" }],
      ]);
      expect(await s.takeAnswered([r.id])).toEqual([]);
      // Closed (timed out) inputs refuse late answers.
      await s.openInput({ id: `${r.id}:c2`, runId: r.id, sessionId: m.id, owner: "local", kind: "client-tool" });
      await s.closeInput(`${r.id}:c2`);
      expect(await s.answerInput(`${r.id}:c2`, "client-tool", "local", { ok: true })).toBeUndefined();
      await s.openInput({ id: `${r.id}:c3`, runId: r.id, sessionId: m.id, owner: "local", kind: "client-tool" });
      await s.closeRunInputs(r.id);
      expect(await s.answerInput(`${r.id}:c3`, "client-tool", "local", { ok: true })).toBeUndefined();
    });
  });
}

let fileDir: string;
contract(
  "file",
  async () => {
    fileDir = mkdtempSync(join(tmpdir(), "agent-store-"));
    return new FileSessionStore(join(fileDir, "sessions"), join(fileDir, "runs"));
  },
  async () => rmSync(fileDir, { recursive: true, force: true }),
);

describe("file store", () => {
  it("finds and deletes runs on disk that this process never loaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-store-"));
    const a = new FileSessionStore(join(dir, "sessions"), join(dir, "runs"));
    const m = meta();
    await a.putMeta(m);
    const r = run(m.id);
    await a.insertRun(r);
    const b = new FileSessionStore(join(dir, "sessions"), join(dir, "runs"));
    expect(await b.runIdsForSessions([m.id])).toEqual([r.id]);
    await b.deleteSession(m.id);
    const c = new FileSessionStore(join(dir, "sessions"), join(dir, "runs"));
    expect(await c.getRun(r.id)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks runs left active by a previous process as interrupted at init", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-store-"));
    const a = new FileSessionStore(join(dir, "sessions"), join(dir, "runs"));
    const m = meta();
    await a.putMeta(m);
    const r = run(m.id);
    await a.insertRun(r);
    const b = new FileSessionStore(join(dir, "sessions"), join(dir, "runs"));
    await b.init();
    expect((await b.getRun(r.id))?.status).toBe("interrupted");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("migrations (todo22 W4)", () => {
  it("v5 adds the chat columns and the thread-part table", () => {
    const v5 = MIGRATIONS.find((m) => m.version === 5)!;
    expect(v5.sql).toMatch(/ADD COLUMN notes jsonb/);
    expect(v5.sql).toMatch(/ADD COLUMN profile text/);
    expect(v5.sql).toMatch(/ADD COLUMN last_opened_at timestamptz/);
    expect(v5.sql).toMatch(/CREATE TABLE agent_ui_parts[\s\S]*ON DELETE CASCADE/);
  });
});

const schema = `agent_test_${randomUUID().slice(0, 8)}`;
describe.skipIf(!PG)("postgres store", () => {
  contract(
    "postgres",
    async () => {
      const s = new PostgresSessionStore(PG!, { schema, autoMigrate: true });
      await s.init();
      return s;
    },
    async () => {
      const pool = new pg.Pool({ connectionString: PG });
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  );

  it("mirrors notes, profile and last_opened_at into their columns (todo22 W4)", async () => {
    const s = new PostgresSessionStore(PG!, { schema, autoMigrate: true });
    await s.init();
    const m = { ...meta(), notes: ["a note"], lastOpenedAt: "2026-11-03T10:00:00.000Z" };
    await s.putMeta(m);
    const pool = new pg.Pool({ connectionString: PG });
    try {
      const r = await pool.query(`SELECT notes, profile, last_opened_at FROM "${schema}".agent_sessions WHERE id = $1`, [m.id]);
      expect(r.rows[0]).toMatchObject({ notes: ["a note"], profile: "assistant" });
      expect(new Date(r.rows[0].last_opened_at).toISOString()).toBe("2026-11-03T10:00:00.000Z");
    } finally {
      await pool.end();
      await s.close();
    }
  });

  it("migrations are idempotent and safe to run concurrently; init without them fails with the command to run", async () => {
    const other = `agent_test_${randomUUID().slice(0, 8)}`;
    const pool = new pg.Pool({ connectionString: PG, max: 4 });
    try {
      const unmigrated = new PostgresSessionStore(PG!, { schema: other });
      await expect(unmigrated.init()).rejects.toThrow(/pnpm --filter @studio\/agent migrate/);
      await unmigrated.close();
      const results = await Promise.all([migrate(pool, other), migrate(pool, other), migrate(pool, other)]);
      expect(results.flat()).toEqual(MIGRATIONS.map((m) => m.version));
      expect(await migrate(pool, other)).toEqual([]);
      expect(await schemaVersion(pool, other)).toBe(MIGRATIONS.at(-1)!.version);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${other}" CASCADE`);
      await pool.end();
    }
  });

  it("revisions move with every write, so a replica can tell its cached session is stale", async () => {
    const s = new PostgresSessionStore(PG!, { schema, autoMigrate: true });
    await s.init();
    try {
      const m = meta();
      const r1 = await s.putMeta(m);
      const r2 = await s.appendTranscript(m.id, 0, [{ type: "session" }]);
      expect(r2).toBeGreaterThan(r1);
      expect(await s.revision(m.id)).toBe(r2);
      // Re-writing a position is a no-op for the data (idempotent retries).
      await s.appendTranscript(m.id, 0, [{ type: "other" }]);
      expect(await s.readTranscript(m.id)).toEqual([{ type: "session" }]);
      expect(await s.revision("ses_nope")).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});
