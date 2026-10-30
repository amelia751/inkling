import { serve } from "@hono/node-server";
import { dataDir, createModelRuntime } from "./agent/models.ts";
import { type ReadyCheck, createApp } from "./app.ts";
import { type Config, ConfigError, describeSecrets, loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { SessionService } from "./runtime/sessions.ts";
import { createDaytona } from "./sandbox/client.ts";
import { DEFAULT_EGRESS, type EgressPolicy } from "./sandbox/defaults.ts";
import { probeEgress } from "./sandbox/egress.ts";
import { getSnapshotStatus } from "./sandbox/snapshot.ts";
import { runSweep } from "./sandbox/sweeper.ts";
import { ensureDevServiceToken, loadDevSecrets } from "./secrets.ts";

const SWEEP_EVERY_MS = 10 * 60 * 1000;
const READY_CACHE_MS = 60 * 1000;

const bootLog = createLogger();
const loaded = loadDevSecrets();
ensureDevServiceToken();

let config: Config;
let warnings: string[];
try {
  ({ config, warnings } = loadConfig());
} catch (err) {
  bootLog.fatal({ err: err instanceof ConfigError ? err.message : String(err) }, "invalid configuration");
  process.exit(1);
}
const log = createLogger(config.logLevel);
if (loaded.length) log.info({ keys: loaded }, "loaded dev secrets from secrets/*.env");
log.info({ secrets: describeSecrets(config), model: `${config.model.provider}:${config.model.id}`, appEnv: config.env }, "config");
for (const w of warnings) log.warn(w);

const runtime = await createModelRuntime(config);
const daytona = createDaytona(config);
let egress: EgressPolicy & { detail?: string } = { ...DEFAULT_EGRESS, detail: daytona ? "not probed yet" : "sandbox off" };
if (daytona && config.egressProbe === "auto") {
  // Never block startup on a sandbox create; sessions use the conservative default until it lands.
  void probeEgress(daytona, config, dataDir(config)).then(
    (r) => {
      egress = r;
      log.info({ canOverride: r.canOverride, detail: r.detail }, "egress probe");
    },
    (err) => log.warn({ err: String(err) }, "egress probe failed"),
  );
}

const sessions = new SessionService({ config, runtime, log, daytona, egress: () => egress });

let readyCache: { at: number; value: ReadyCheck } | undefined;
async function ready(): Promise<ReadyCheck> {
  if (readyCache && Date.now() - readyCache.at < READY_CACHE_MS) return readyCache.value;
  const checks: ReadyCheck["checks"] = {
    config: { ok: true },
    model: {
      ok: config.model.provider === "scripted" || !!config.providerKeys[config.model.provider],
      detail: `${config.model.provider}:${config.model.id}`,
    },
  };
  if (daytona) {
    try {
      const snap = await getSnapshotStatus(daytona);
      checks.daytona = { ok: true, detail: `snapshot ${snap.name} ${snap.state}` };
    } catch (err) {
      checks.daytona = { ok: false, detail: String((err as Error).message).slice(0, 200) };
    }
    checks.egress = { ok: true, detail: `${egress.canOverride ? "custom rules allowed" : "org policy"}: ${egress.detail ?? ""}` };
  } else {
    checks.daytona = { ok: true, detail: "sandbox off (no DAYTONA_API_KEY)" };
  }
  const value = { ok: Object.values(checks).every((c) => c.ok), checks };
  readyCache = { at: Date.now(), value };
  return value;
}

async function sweep() {
  if (!daytona) return;
  try {
    const r = await runSweep(
      daytona,
      {
        env: config.env,
        activeSessions: sessions.activeSessionIds(),
        knownSessions: sessions.knownSessionIds(),
        idleStopMin: config.sweep.idleStopMin,
        retentionDays: config.sweep.retentionDays,
        maxDeletes: 5,
      },
      { log: (m) => log.info(m) },
    );
    if (r.stopped.length || r.deleted.length || r.errors.length) log.info({ stopped: r.stopped.length, deleted: r.deleted.length, errors: r.errors }, "sweep");
  } catch (err) {
    log.warn({ err: String(err) }, "sweep failed");
  }
}
void sweep();
const sweeper = setInterval(() => void sweep(), SWEEP_EVERY_MS);
sweeper.unref();

const app = createApp({ config, sessions, log, ready });
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
  log.info({ url: `http://${info.address}:${info.port}` }, "agent service listening"),
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  clearInterval(sweeper);
  server.close();
  await Promise.race([sessions.shutdown(), new Promise((r) => setTimeout(r, 20_000))]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
