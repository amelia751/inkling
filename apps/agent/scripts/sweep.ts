/**
 * Manual GC for Inkling sandboxes (todo1 §4.6). Only `app=inkling` sandboxes in one env are touched.
 * Also the `agent-sweeper` CronJob when replicas run with SWEEPER_ENABLED=false: known and active
 * sessions come from the configured store (AGENT_STORE), so runs on any replica are respected.
 *
 *   pnpm --filter @studio/agent sweep -- --dry-run                 list and plan (default)
 *   pnpm --filter @studio/agent sweep -- --stop                    stop idle started sandboxes
 *   pnpm --filter @studio/agent sweep -- --delete                  also delete orphans / expired
 *   … --env test --label test=live --all                            every match, ignoring idle/age rules
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { createDaytona } from "../src/sandbox/client.ts";
import { listOwned, planSweep, toCandidate } from "../src/sandbox/sweeper.ts";
import { loadDevSecrets } from "../src/secrets.ts";
import { createStore } from "../src/store/index.ts";
import { NAMING } from "../src/naming.ts";

const RES = NAMING.resourcePrefix;

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean" },
    stop: { type: "boolean" },
    delete: { type: "boolean" },
    all: { type: "boolean" },
    env: { type: "string" },
    label: { type: "string", multiple: true },
  },
});

loadDevSecrets();
const { config } = loadConfig();
const daytona = createDaytona(config);
if (!daytona) {
  console.error("DAYTONA_API_KEY is not set (secrets/daytona.env).");
  process.exit(1);
}
const env = values.env ?? config.env;
const labels = Object.fromEntries((values.label ?? []).map((l) => l.split("=") as [string, string]));
const sandboxes = await listOwned(daytona, env, labels);
const candidates = sandboxes.map(toCandidate);
console.log(`${candidates.length} sandbox(es) with app=${RES} env=${env}${values.label ? ` ${values.label.join(" ")}` : ""}`);
for (const c of candidates) console.log(`  ${c.name.padEnd(48)} ${String(c.state).padEnd(10)} last=${c.lastActivityAt ?? "?"} session=${c.labels.session ?? "?"}`);

// Sessions the store knows (the file store's .data dir in dev, Postgres otherwise); others count as
// orphans. Sessions with an active run in the store are never touched (the file store only sees
// runs of a service that shares its data dir).
const store = createStore(config);
await store.init();
const known = await store.listSessionIds();
const active = await store.activeSessionIds();
await store.close();
const plan = values.all
  ? { stop: candidates.filter((c) => c.state === "started"), delete: candidates.map((sandbox) => ({ sandbox, reason: "orphan" as const })) }
  : planSweep(candidates, { env, now: Date.now(), activeSessions: active, knownSessions: known, idleStopMin: config.sweep.idleStopMin, retentionDays: config.sweep.retentionDays, maxDeletes: 5 });

console.log(`plan: stop ${plan.stop.length}, delete ${plan.delete.length}`);
const byId = new Map(sandboxes.map((s) => [s.id, s]));
if (!values.stop && !values.delete) {
  for (const c of plan.stop) console.log(`  would stop   ${c.name}`);
  for (const d of plan.delete) console.log(`  would delete ${d.sandbox.name} (${d.reason})`);
  console.log("dry run; pass --stop or --delete to act.");
  process.exit(0);
}
if (values.delete) {
  for (const { sandbox: c, reason } of plan.delete) {
    await byId.get(c.id)!.delete(60).then(
      () => console.log(`deleted ${c.name} (${reason}) labels=${JSON.stringify(c.labels)}`),
      (e) => console.error(`delete ${c.name} failed: ${(e as Error).message}`),
    );
  }
}
const deleted = new Set(values.delete ? plan.delete.map((d) => d.sandbox.id) : []);
for (const c of plan.stop) {
  if (deleted.has(c.id)) continue;
  await byId.get(c.id)!.stop(60).then(
    () => console.log(`stopped ${c.name}`),
    (e) => console.error(`stop ${c.name} failed: ${(e as Error).message}`),
  );
}
