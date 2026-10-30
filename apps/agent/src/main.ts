import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { initTracing, installFetchPropagation, sameOriginAs } from "@studio/observability-ts";
import { dataDir, createModelRuntime } from "./agent/models.ts";
import { type ReadyCheck, createApp } from "./app.ts";
import { createBus } from "./bus/index.ts";
import { SERVICE_NAME, SERVICE_VERSION } from "./cluster/naming.ts";
import { type Config, ConfigError, describeSecrets, envName, loadConfig } from "./config.ts";
import { createServiceLog } from "./observability.ts";
import { SessionService } from "./runtime/sessions.ts";
import { createDaytona } from "./sandbox/client.ts";
import { DEFAULT_EGRESS, type EgressPolicy } from "./sandbox/defaults.ts";
import { probeEgress } from "./sandbox/egress.ts";
import { getSnapshotStatus } from "./sandbox/snapshot.ts";
import { runSweep } from "./sandbox/sweeper.ts";
import { ensureDevServiceToken, loadDevSecrets } from "./secrets.ts";
import { createStore } from "./store/index.ts";

const SWEEP_EVERY_MS = 10 * 60 * 1000;
const READY_CACHE_MS = 60 * 1000;

const bootLog = createServiceLog();
const loaded = loadDevSecrets();
ensureDevServiceToken();

let config: Config;
let warnings: string[];
try {
  ({ config, warnings } = loadConfig());
} catch (err) {
  // ConfigError messages name keys only, never values.
  bootLog.fatal({ err: err instanceof ConfigError ? err.message : String(err) }, "invalid configuration");
  process.exit(1);
}
// Same place whether started from src/ (tsx) or dist/ (node): <package>/.data.
config.dataDir ??= resolve(import.meta.dirname, "../.data");
const log = createServiceLog(config.logLevel, config.gitSha);
if (loaded.length) log.info({ keys: loaded }, "loaded dev secrets from secrets/*.env");
log.info(
  {
    secrets: describeSecrets(config),
    model: `${config.model.provider}:${config.model.id}`,
    appEnv: config.env,
    store: config.store.kind,
    bus: config.bus.kind,
    replica: config.cluster.replicaId,
  },
  "config",
);
for (const w of warnings) log.warn(w);

const tracing = await initTracing({ service: SERVICE_NAME, version: SERVICE_VERSION, warn: (m) => log.warn(m) });
installFetchPropagation(sameOriginAs([config.kernelUrl, config.studioUrl]));

const store = createStore(config, (m) => log.info(m));
const bus = createBus(config, (m) => log.warn(m));
try {
  await store.init();
  await bus.init();
} catch (err) {
  log.fatal({ err: String((err as Error).message ?? err), store: config.store.kind, bus: config.bus.kind }, "state backends unavailable");
  process.exit(1);
}

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

const sessions = new SessionService({ config, runtime, log, daytona, egress: () => egress, store, bus });

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
        // Runs on every replica count, not just this one's.
        activeSessions: await sessions.cluster.activeSessionIds(),
        knownSessions: await sessions.knownSessionIds(),
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
let sweeper: NodeJS.Timeout | undefined;
if (config.sweeperEnabled) {
  void sweep();
  sweeper = setInterval(() => void sweep(), SWEEP_EVERY_MS);
  sweeper.unref();
} else {
  log.info(`in-process sweeper disabled (${envName("AGENT_SWEEPER_ENABLED")}=false); run scripts/sweep.ts as a CronJob`);
}

const app = createApp({ config, sessions, log, ready });
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
  log.info({ url: `http://${info.address}:${info.port}`, replica: config.cluster.replicaId }, "agent service listening"),
);

/**
 * SIGTERM (Kubernetes): /readyz fails at once so the pod leaves the Service; new runs get 503 while
 * everything else is still served; in-flight runs get AGENT_SHUTDOWN_GRACE_S to finish, the rest are
 * marked interrupted; then this pod's Daytona sandboxes are stopped and connections closed.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) {
    log.warn({ signal }, "second signal: exiting now");
    process.exit(1);
  }
  stopping = true;
  log.info({ signal, graceS: config.shutdownGraceS, localRuns: sessions.cluster.localRunCount }, "draining");
  if (sweeper) clearInterval(sweeper);
  try {
    const interrupted = await sessions.drain(config.shutdownGraceS * 1000);
    if (interrupted) log.warn({ interrupted }, "runs interrupted at shutdown");
    await Promise.race([sessions.shutdown(), new Promise((r) => setTimeout(r, 15_000))]);
  } catch (err) {
    log.error({ err: String(err) }, "shutdown failed");
  }
  server.close();
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await Promise.allSettled([bus.close(), store.close(), tracing.shutdown()]);
  log.info("stopped");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
