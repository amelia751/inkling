/**
 * Apply the agent's Postgres schema (<P>AGENT_DATABASE_URL, <P>AGENT_DATABASE_SCHEMA; <P> is the naming
 * config's env prefix). Idempotent and safe to run concurrently (advisory lock). Run as a pre-deploy
 * Job, or set <P>AGENT_AUTO_MIGRATE=1 in dev.
 *
 *   pnpm --filter @studio/agent migrate            apply pending migrations
 *   pnpm --filter @studio/agent migrate --check    exit 1 if the schema is behind
 */
import { parseArgs } from "node:util";
import pg from "pg";
import { env, envName } from "../src/config.ts";
import { loadDevSecrets } from "../src/secrets.ts";
import { LATEST_VERSION, migrate, schemaVersion } from "../src/store/migrations.ts";

// `pnpm --filter … migrate -- --check` passes the `--` through; ignore it.
const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { check: { type: "boolean" } } });
loadDevSecrets();
const url = env("AGENT_DATABASE_URL");
const schema = env("AGENT_DATABASE_SCHEMA") || "public";
if (!url) {
  console.error(`missing required settings: ${envName("AGENT_DATABASE_URL")}`);
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
  console.error(`invalid settings: ${envName("AGENT_DATABASE_SCHEMA")}`);
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
try {
  if (values.check) {
    const v = await schemaVersion(pool, schema);
    console.log(`agent schema ${schema}: version ${v}, latest ${LATEST_VERSION}`);
    process.exitCode = v < LATEST_VERSION ? 1 : 0;
  } else {
    const applied = await migrate(pool, schema, (m) => console.log(m));
    console.log(applied.length ? `applied ${applied.join(", ")}` : `agent schema ${schema} is up to date (version ${LATEST_VERSION})`);
  }
} catch (err) {
  console.error(`migration failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
