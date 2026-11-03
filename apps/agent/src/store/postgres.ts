import pg from "pg";
import { envName } from "../config.ts";
import { LATEST_VERSION, ident, migrate, schemaVersion } from "./migrations.ts";
import { ACTIVE_STATUSES, type InputKind, type InputRecord, type RunRecord, type RunUsage, type SessionStore, type StoredMeta, type StoredRunStatus } from "./types.ts";

const ACTIVE = ACTIVE_STATUSES.map((s) => `'${s}'`).join(", ");

interface RunRow {
  id: string;
  session_id: string;
  owner: string;
  status: StoredRunStatus;
  replica: string;
  usage: string | null;
  tool_calls: number;
  created_at: Date;
  updated_at: Date;
  heartbeat_at: Date;
}

interface InputRow {
  id: string;
  run_id: string;
  session_id: string;
  owner: string;
  kind: InputKind;
  state: InputRecord["state"];
  payload: string | null;
  created_at: Date;
}

const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  sessionId: r.session_id,
  owner: r.owner,
  status: r.status,
  replica: r.replica,
  createdAt: r.created_at.getTime(),
  updatedAt: r.updated_at.getTime(),
  heartbeatAt: r.heartbeat_at.getTime(),
  usage: r.usage ? (JSON.parse(r.usage) as RunUsage) : undefined,
  toolCalls: r.tool_calls,
});

const toInput = (r: InputRow): InputRecord => ({
  id: r.id,
  runId: r.run_id,
  sessionId: r.session_id,
  owner: r.owner,
  kind: r.kind,
  state: r.state,
  payload: r.payload === null ? undefined : (JSON.parse(r.payload) as unknown),
  createdAt: r.created_at.getTime(),
});

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/**
 * Postgres store (AGENT_STORE=postgres). Every replica reads and writes the same rows; the partial
 * unique index `agent_runs_one_active` makes "one active run per session" hold cluster-wide, and
 * lease checks use the database clock so pod clock skew doesn't matter.
 */
export class PostgresSessionStore implements SessionStore {
  readonly kind = "postgres" as const;
  readonly pool: pg.Pool;

  constructor(
    url: string,
    private readonly opts: { schema?: string; autoMigrate?: boolean; log?: (msg: string) => void; max?: number } = {},
  ) {
    const schema = opts.schema ?? "public";
    this.pool = new pg.Pool({
      connectionString: url,
      max: opts.max ?? 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30_000,
      // Unqualified table names resolve in the configured schema.
      options: `-c search_path=${ident(schema)}`,
    });
    // An idle client erroring (DB restart) must not crash the process; the next query reconnects.
    this.pool.on("error", (err) => opts.log?.(`postgres pool error: ${err.message}`));
  }

  private get schema() {
    return this.opts.schema ?? "public";
  }

  async init(): Promise<void> {
    if (this.opts.autoMigrate) {
      await migrate(this.pool, this.schema, this.opts.log);
      return;
    }
    const v = await schemaVersion(this.pool, this.schema);
    if (v < LATEST_VERSION)
      throw new Error(`agent database schema is at version ${v}, need ${LATEST_VERSION}: run \`pnpm --filter @studio/agent migrate\` (or set ${envName("AGENT_AUTO_MIGRATE")}=1 in dev)`);
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ---- sessions ----

  async getMeta(id: string): Promise<StoredMeta | undefined> {
    const r = await this.pool.query<{ meta: string }>("SELECT meta FROM agent_sessions WHERE id = $1", [id]);
    return r.rows[0] ? (JSON.parse(r.rows[0].meta) as StoredMeta) : undefined;
  }

  async putMeta(meta: StoredMeta): Promise<number> {
    const r = await this.pool.query<{ rev: string }>(
      `INSERT INTO agent_sessions (id, owner, project_id, org_id, meta, rev) VALUES ($1, $2, $3, $4, $5, 1)
       ON CONFLICT (id) DO UPDATE SET meta = EXCLUDED.meta, rev = agent_sessions.rev + 1, updated_at = now()
       RETURNING rev`,
      [meta.id, meta.owner, meta.projectId, meta.orgId ?? null, JSON.stringify(meta)],
    );
    return Number(r.rows[0]!.rev);
  }

  async listSessions({ owner, orgId, projectId }: { owner: string; orgId: string | undefined; projectId?: string }): Promise<StoredMeta[]> {
    const r = await this.pool.query<{ meta: string }>(
      `SELECT meta FROM agent_sessions
       WHERE owner = $1 AND org_id IS NOT DISTINCT FROM $2 AND ($3::text IS NULL OR project_id = $3)
       ORDER BY created_at DESC`,
      [owner, orgId ?? null, projectId ?? null],
    );
    return r.rows.map((x) => JSON.parse(x.meta) as StoredMeta);
  }

  async listOrgSessions({ orgId, owner }: { orgId: string; owner?: string }): Promise<StoredMeta[]> {
    const r = await this.pool.query<{ meta: string }>(
      "SELECT meta FROM agent_sessions WHERE org_id = $1 AND ($2::text IS NULL OR owner = $2)",
      [orgId, owner ?? null],
    );
    return r.rows.map((x) => JSON.parse(x.meta) as StoredMeta);
  }

  async runIdsForSessions(sessionIds: string[]): Promise<string[]> {
    if (!sessionIds.length) return [];
    const r = await this.pool.query<{ id: string }>("SELECT id FROM agent_runs WHERE session_id = ANY($1::text[])", [sessionIds]);
    return r.rows.map((x) => x.id);
  }

  async listSessionIds(): Promise<Set<string>> {
    const r = await this.pool.query<{ id: string }>("SELECT id FROM agent_sessions");
    return new Set(r.rows.map((x) => x.id));
  }

  async countSessions(): Promise<number> {
    const r = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM agent_sessions");
    return Number(r.rows[0]!.n);
  }

  async deleteSession(id: string): Promise<void> {
    await this.pool.query("DELETE FROM agent_sessions WHERE id = $1", [id]);
  }

  async revision(id: string): Promise<number | undefined> {
    const r = await this.pool.query<{ rev: string }>("SELECT rev FROM agent_sessions WHERE id = $1", [id]);
    return r.rows[0] ? Number(r.rows[0].rev) : undefined;
  }

  async readTranscript(id: string): Promise<unknown[]> {
    const r = await this.pool.query<{ entry: string }>("SELECT entry FROM agent_transcript WHERE session_id = $1 ORDER BY idx", [id]);
    return r.rows.map((x) => JSON.parse(x.entry) as unknown);
  }

  async appendTranscript(id: string, from: number, items: unknown[]): Promise<number | undefined> {
    if (!items.length) return undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO agent_transcript (session_id, idx, entry)
         SELECT $1, idx, entry FROM unnest($2::int[], $3::text[]) AS t(idx, entry)
         ON CONFLICT (session_id, idx) DO NOTHING`,
        [id, items.map((_, i) => from + i), items.map((e) => JSON.stringify(e))],
      );
      const r = await client.query<{ rev: string }>("UPDATE agent_sessions SET rev = rev + 1, updated_at = now() WHERE id = $1 RETURNING rev", [id]);
      await client.query("COMMIT");
      return r.rows[0] ? Number(r.rows[0].rev) : undefined;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async branchSession(sourceId: string, uptoIdx: number, meta: StoredMeta, header: unknown): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO agent_sessions (id, owner, project_id, org_id, meta, rev) VALUES ($1, $2, $3, $4, $5, 1)", [
        meta.id,
        meta.owner,
        meta.projectId,
        meta.orgId ?? null,
        JSON.stringify(meta),
      ]);
      await client.query("INSERT INTO agent_transcript (session_id, idx, entry) VALUES ($1, 0, $2)", [meta.id, JSON.stringify(header)]);
      await client.query(
        `INSERT INTO agent_transcript (session_id, idx, entry)
         SELECT $1, idx, entry FROM agent_transcript WHERE session_id = $2 AND idx > 0 AND idx < $3`,
        [meta.id, sourceId, uptoIdx],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ---- runs ----

  async insertRun(rec: RunRecord): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO agent_runs (id, session_id, owner, status, replica, usage, tool_calls)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
      [rec.id, rec.sessionId, rec.owner, rec.status, rec.replica, json(rec.usage), rec.toolCalls ?? 0],
    );
    return r.rowCount === 1;
  }

  async updateRun(id: string, patch: { status?: StoredRunStatus; usage?: RunUsage; toolCalls?: number }): Promise<void> {
    // Terminal states are final: a late write from a slow replica can't resurrect an interrupted run.
    await this.pool.query(
      `UPDATE agent_runs SET
         status = CASE WHEN status IN (${ACTIVE}) THEN coalesce($2, status) ELSE status END,
         usage = coalesce($3, usage),
         tool_calls = coalesce($4, tool_calls),
         updated_at = now()
       WHERE id = $1`,
      [id, patch.status ?? null, json(patch.usage), patch.toolCalls ?? null],
    );
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const r = await this.pool.query<RunRow>("SELECT * FROM agent_runs WHERE id = $1", [id]);
    return r.rows[0] ? toRun(r.rows[0]) : undefined;
  }

  async activeRunForSession(sessionId: string): Promise<RunRecord | undefined> {
    const r = await this.pool.query<RunRow>(`SELECT * FROM agent_runs WHERE session_id = $1 AND status IN (${ACTIVE}) LIMIT 1`, [sessionId]);
    return r.rows[0] ? toRun(r.rows[0]) : undefined;
  }

  async activeSessionIds(): Promise<Set<string>> {
    const r = await this.pool.query<{ session_id: string }>(`SELECT DISTINCT session_id FROM agent_runs WHERE status IN (${ACTIVE})`);
    return new Set(r.rows.map((x) => x.session_id));
  }

  async heartbeat(ids: string[], replica: string): Promise<string[]> {
    if (!ids.length) return [];
    const r = await this.pool.query<{ id: string }>(
      `UPDATE agent_runs SET heartbeat_at = now() WHERE id = ANY($1::text[]) AND replica = $2 AND status IN (${ACTIVE}) RETURNING id`,
      [ids, replica],
    );
    const kept = new Set(r.rows.map((x) => x.id));
    return ids.filter((id) => !kept.has(id));
  }

  async interruptIfStale(id: string, leaseMs: number): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE agent_runs SET status = 'interrupted', updated_at = now()
       WHERE id = $1 AND status IN (${ACTIVE}) AND heartbeat_at < now() - make_interval(secs => $2::double precision / 1000)
       RETURNING id`,
      [id, leaseMs],
    );
    if (r.rowCount !== 1) return false;
    await this.closeRunInputs(id);
    return true;
  }

  async markInterrupted(id: string): Promise<void> {
    await this.pool.query(`UPDATE agent_runs SET status = 'interrupted', updated_at = now() WHERE id = $1 AND status IN (${ACTIVE})`, [id]);
    await this.closeRunInputs(id);
  }

  // ---- inputs ----

  async openInput(rec: Omit<InputRecord, "state" | "createdAt">): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_run_inputs (id, run_id, session_id, owner, kind, state, payload) VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       ON CONFLICT (id) DO NOTHING`,
      [rec.id, rec.runId, rec.sessionId, rec.owner, rec.kind, json(rec.payload)],
    );
  }

  async answerInput(id: string, kind: InputKind, owner: string, payload: unknown): Promise<InputRecord | undefined> {
    const r = await this.pool.query<InputRow>(
      `UPDATE agent_run_inputs i SET state = 'answered', payload = $4, updated_at = now()
       FROM agent_runs r
       WHERE i.id = $1 AND i.kind = $2 AND i.owner = $3 AND i.state = 'pending' AND r.id = i.run_id AND r.status IN (${ACTIVE})
       RETURNING i.*`,
      [id, kind, owner, json(payload)],
    );
    return r.rows[0] ? toInput(r.rows[0]) : undefined;
  }

  async pushCommand(rec: Omit<InputRecord, "state" | "createdAt">): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_run_inputs (id, run_id, session_id, owner, kind, state, payload) VALUES ($1, $2, $3, $4, $5, 'answered', $6)`,
      [rec.id, rec.runId, rec.sessionId, rec.owner, rec.kind, json(rec.payload)],
    );
  }

  async takeAnswered(runIds: string[]): Promise<InputRecord[]> {
    if (!runIds.length) return [];
    const r = await this.pool.query<InputRow>(
      `UPDATE agent_run_inputs SET state = 'closed', updated_at = now() WHERE run_id = ANY($1::text[]) AND state = 'answered' RETURNING *`,
      [runIds],
    );
    return r.rows.map(toInput).sort((a, b) => a.createdAt - b.createdAt);
  }

  async closeInput(id: string): Promise<void> {
    await this.pool.query("UPDATE agent_run_inputs SET state = 'closed', updated_at = now() WHERE id = $1 AND state <> 'closed'", [id]);
  }

  async closeRunInputs(runId: string): Promise<void> {
    await this.pool.query("UPDATE agent_run_inputs SET state = 'closed', updated_at = now() WHERE run_id = $1 AND state <> 'closed'", [runId]);
  }
}
