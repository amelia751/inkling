import type pg from "pg";

/**
 * Postgres schema for the agent store, applied in order and recorded in `agent_schema_migrations`.
 * Append new versions; never edit an applied one. JSON payloads are stored as text (pi transcripts
 * may contain `\u0000`, which jsonb rejects).
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE agent_sessions (
  id          text PRIMARY KEY,
  owner       text NOT NULL,
  project_id  text NOT NULL,
  meta        text NOT NULL,
  rev         bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_sessions_owner ON agent_sessions (owner);

CREATE TABLE agent_transcript (
  session_id  text NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
  idx         integer NOT NULL,
  entry       text NOT NULL,
  PRIMARY KEY (session_id, idx)
);

CREATE TABLE agent_runs (
  id            text PRIMARY KEY,
  session_id    text NOT NULL REFERENCES agent_sessions (id) ON DELETE CASCADE,
  owner         text NOT NULL,
  status        text NOT NULL,
  replica       text NOT NULL,
  usage         text,
  tool_calls    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  heartbeat_at  timestamptz NOT NULL DEFAULT now()
);
-- One active run per session across all replicas.
CREATE UNIQUE INDEX agent_runs_one_active ON agent_runs (session_id) WHERE status IN ('queued', 'running', 'awaiting_approval');
CREATE INDEX agent_runs_session ON agent_runs (session_id, created_at);

CREATE TABLE agent_run_inputs (
  id          text PRIMARY KEY,
  run_id      text NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  session_id  text NOT NULL,
  owner       text NOT NULL,
  kind        text NOT NULL,
  state       text NOT NULL,
  payload     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_run_inputs_answered ON agent_run_inputs (run_id) WHERE state = 'answered';
`,
  },
  {
    // todo9 Phase 5: sessions belong to a person in one organization. Rows from before (owner `local`,
    // no org) stay; no signed-in person can list them.
    version: 2,
    sql: `
ALTER TABLE agent_sessions ADD COLUMN org_id text;
CREATE INDEX agent_sessions_owner_org ON agent_sessions (owner, org_id);
`,
  },
];

export const LATEST_VERSION = MIGRATIONS.at(-1)!.version;

const LOCK_KEY = "agent_schema_migrations";

/** Apply pending migrations under an advisory lock, so concurrent replicas/Jobs don't race. */
export async function migrate(pool: pg.Pool, schema: string, log: (msg: string) => void = () => {}): Promise<number[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`${schema}.${LOCK_KEY}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${ident(schema)}.agent_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ version: number }>(`SELECT version FROM ${ident(schema)}.agent_schema_migrations`)).rows.map((r) => r.version));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL search_path TO ${ident(schema)}`);
        await client.query(m.sql);
        await client.query(`INSERT INTO ${ident(schema)}.agent_schema_migrations (version) VALUES ($1)`, [m.version]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
      applied.push(m.version);
      log(`applied agent schema migration ${m.version}`);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`${schema}.${LOCK_KEY}`]).catch(() => {});
    client.release();
  }
}

/** Highest applied version, or 0 when the schema doesn't exist yet. */
export async function schemaVersion(pool: pg.Pool, schema: string): Promise<number> {
  const exists = await pool.query("SELECT to_regclass($1) AS t", [`${schema}.agent_schema_migrations`]);
  if (!exists.rows[0]?.t) return 0;
  const r = await pool.query<{ v: number | null }>(`SELECT max(version) AS v FROM ${ident(schema)}.agent_schema_migrations`);
  return r.rows[0]?.v ?? 0;
}

/** Schema names are validated by config (`[a-z_][a-z0-9_]*`); quote anyway. */
export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
