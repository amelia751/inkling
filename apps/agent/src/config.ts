import { randomBytes } from "node:crypto";
import { z } from "zod";
import { envKey } from "./naming.ts";
import { maskSecret } from "./secrets.ts";

/**
 * The one place this service reads the environment. Settings are `<envPrefix><KEY>` (the prefix
 * comes from the naming config): `AGENT_*` for this service's own, `ENV` and `LOG_LEVEL` shared by
 * every service, `API_URL` / `WEB_URL` / `AGENT_TOKEN` for how services reach each other.
 * Third-party standards keep their own names.
 */
const UNPREFIXED = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_TARGET",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GIT_SHA",
  "HOSTNAME",
]);
/** The env var a setting is read from. */
export const envName = (key: string) => (UNPREFIXED.has(key) ? key : envKey(key));
/** One setting, e.g. `env("AGENT_DATABASE_URL")`. */
export const env = (key: string, raw: NodeJS.ProcessEnv = process.env): string | undefined => raw[envName(key)];
/** Settings by key → an environment (tests and scripts): `withPrefix({ AGENT_MODEL: "scripted" })`. */
export const withPrefix = (vars: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(vars).map(([k, v]) => [envName(k), v]));

const int = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);
const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));
const flag = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no", ""])
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v === "true" || v === "1" || v === "yes"));

const schema = z.object({
  ENV: z.enum(["development", "test", "production"]).default("development"),
  AGENT_HOST: z.string().default("127.0.0.1"),
  AGENT_PORT: int(8100),
  AGENT_TOKEN: optional,

  AGENT_MODEL: z.string().default("openai:gpt-6.1-sol"),
  AGENT_MODEL_ALLOWLIST: z
    .string()
    .default("openai:gpt-6.1-sol,openai:gpt-6-sol,anthropic:claude-sonnet-5-5,anthropic:claude-opus-5-5"),
  AGENT_THINKING: z.enum(["off", "minimal", "low", "medium", "high"]).default("low"),
  OPENAI_API_KEY: optional,
  ANTHROPIC_API_KEY: optional,
  /**
   * Vertex AI (todo10 D8): `AGENT_MODEL=google-vertex:<model>` calls the model in this project and
   * location with Application Default Credentials (Workload Identity on GKE), never a key.
   */
  GOOGLE_CLOUD_PROJECT: optional,
  GOOGLE_CLOUD_LOCATION: optional,

  /**
   * Which `SandboxProvider` (sandbox/provider.ts, todo10 §6.2): `daytona` (cloud), `local` (a
   * container here, gVisor), `gke` (agent-sandbox on GKE Sandbox), `fake` (in-memory, dev/tests
   * only), `off` (no sandboxes even when a Daytona key is present: e2e, offline dev).
   */
  AGENT_SANDBOX: z.enum(["daytona", "local", "gke", "fake", "off"]).default("daytona"),
  /** `block` (default): a provider that can't cut the network refuses to create. `org-default`: accept the org's policy (dev only). */
  AGENT_SANDBOX_NETWORK: z.enum(["block", "org-default"]).default("block"),
  /** Build sandboxes live at most this long (autoDelete and TTL), whatever the general settings say. */
  AGENT_SANDBOX_BUILD_TTL_MIN: int(60),
  AGENT_SANDBOX_LOCAL_IMAGE: optional,
  AGENT_SANDBOX_LOCAL_RUNTIME: z.string().default("runsc"),
  AGENT_SANDBOX_LOCAL_CLI: z.enum(["docker", "podman"]).default("docker"),
  AGENT_SANDBOX_GKE_NAMESPACE: z.string().default("sandboxes"),
  AGENT_SANDBOX_GKE_TEMPLATE: z.string().default("plugin-build"),
  /** Set by Kubernetes in every pod: the API server the `gke` provider talks to. */
  KUBERNETES_SERVICE_HOST: z.string().default("kubernetes.default.svc"),
  KUBERNETES_SERVICE_PORT: z.string().default("443"),
  /** `fake` only: also write every sandbox's files and command log here (end-to-end tests read it). */
  AGENT_SANDBOX_FAKE_DIR: optional,
  DAYTONA_API_KEY: optional,
  DAYTONA_API_URL: z.string().url().default("https://app.daytona.io/api"),
  DAYTONA_TARGET: optional,

  AGENT_SANDBOX_AUTO_STOP_MIN: int(15),
  AGENT_SANDBOX_AUTO_ARCHIVE_MIN: int(60 * 24),
  AGENT_SANDBOX_AUTO_DELETE_MIN: int(60 * 24 * 7),
  AGENT_SANDBOX_TTL_MIN: int(60 * 24),
  AGENT_SANDBOX_SNAPSHOT: optional,

  AGENT_MAX_TOOL_CALLS: int(80),
  AGENT_MAX_RUN_SECONDS: int(900),
  AGENT_MAX_SPEND_USD: z.coerce.number().nonnegative().default(2),
  AGENT_EXEC_TIMEOUT_S: int(300),
  AGENT_TOOL_OUTPUT_MAX: int(64 * 1024),
  AGENT_CLIENT_TOOL_TIMEOUT_S: int(120),
  AGENT_MAX_SESSIONS: int(50),
  AGENT_MAX_CONCURRENT_RUNS: int(2),
  AGENT_APPROVAL_TIMEOUT_S: int(600),

  /** The Studio (Vite dev server) for the seed API fallback. */
  WEB_URL: z.string().url().default("http://localhost:5173"),
  /** The API (apps/api) for the builder and task profiles' kernel tools; calls there carry `traceparent` / `x-request-id`. */
  API_URL: z.string().url().default("http://127.0.0.1:8000"),
  AGENT_SANDBOX_RETENTION_DAYS: int(7),
  AGENT_SANDBOX_IDLE_STOP_MIN: int(30),
  /** `auto`: probe once (cached a day) whether the org may set egress rules; `off`: assume not. */
  AGENT_EGRESS_PROBE: z.enum(["auto", "off"]).default("auto"),
  /** Fixture for AGENT_MODEL=scripted (dev/test only): a JSON array of scripted assistant turns. */
  AGENT_SCRIPT: optional,
  AGENT_DATA_DIR: optional,
  /**
   * The generated catalogue (schemas/catalog.json) and the preset intent table
   * (registry/intents.json), read once at startup for the Studio tools (todo11). Defaults: the
   * repo copies next to this service (the image ships both).
   */
  AGENT_CATALOG_FILE: optional,
  AGENT_INTENTS_FILE: optional,

  /** Where sessions, transcripts, run records and pending approvals live (store/). */
  AGENT_STORE: z.enum(["file", "postgres"]).default("file"),
  AGENT_DATABASE_URL: optional,
  AGENT_DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default("public"),
  /** Apply the Postgres schema at startup (dev/compose); production runs `pnpm migrate` as a Job. */
  AGENT_AUTO_MIGRATE: flag(false),
  /** How run events reach SSE readers on any replica (bus/). */
  AGENT_EVENT_BUS: z.enum(["memory", "redis"]).default("memory"),
  AGENT_REDIS_URL: optional,
  AGENT_RUN_STREAM_MAXLEN: int(5000),
  AGENT_RUN_STREAM_TTL_S: int(24 * 60 * 60),
  /** A run whose replica hasn't heartbeated for this long is marked interrupted on the next read. */
  AGENT_RUN_LEASE_S: int(30),
  AGENT_RUN_HEARTBEAT_S: int(10),
  /** Fallback poll for approvals/client-tool results answered on another replica (pub/sub is the fast path). */
  AGENT_INBOX_POLL_MS: int(1000),
  AGENT_REPLICA_ID: optional,
  /** SIGTERM: let in-flight runs finish for this long, then mark the rest interrupted (k8s grace is 120 s). */
  AGENT_SHUTDOWN_GRACE_S: int(100),
  /** In-process Daytona sweeper; turn off when the agent-sweeper CronJob runs `scripts/sweep.ts`. */
  AGENT_SWEEPER_ENABLED: flag(true),
  /** Injected at image build (`--build-arg GIT_SHA`); served by GET /version. */
  GIT_SHA: optional,
  HOSTNAME: optional,
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
});

export type Env = z.infer<typeof schema>;

export interface Config {
  env: Env["ENV"];
  host: string;
  port: number;
  serviceToken: string | undefined;
  model: { provider: string; id: string; allowlist: string[]; thinking: Env["AGENT_THINKING"] };
  providerKeys: Record<string, string>;
  /** Set when Vertex AI is configured (project and location); its "key" in providerKeys is the ADC marker. */
  vertex: { project: string; location: string } | undefined;
  daytona: { apiKey: string; apiUrl: string; target: string | undefined } | undefined;
  sandbox: {
    provider: Env["AGENT_SANDBOX"];
    network: Env["AGENT_SANDBOX_NETWORK"];
    buildTtlMin: number;
    local: { image: string | undefined; runtime: string; cli: Env["AGENT_SANDBOX_LOCAL_CLI"] };
    gke: { namespace: string; template: string; apiServer: string };
    fakeDir: string | undefined;
    autoStopMin: number;
    autoArchiveMin: number;
    autoDeleteMin: number;
    ttlMin: number;
    snapshot: string | undefined;
    execTimeoutS: number;
    outputMax: number;
  };
  budgets: { maxToolCalls: number; maxRunSeconds: number; maxSpendUsd: number };
  clientToolTimeoutS: number;
  approvalTimeoutS: number;
  limits: { maxSessions: number; maxConcurrentRuns: number };
  studioUrl: string;
  kernelUrl: string;
  sweep: { retentionDays: number; idleStopMin: number };
  egressProbe: "auto" | "off";
  /** Set when the model is `scripted`: path of the replay fixture. */
  script: string | undefined;
  dataDir: string | undefined;
  /** Overrides for schemas/catalog.json and registry/intents.json (agent/catalog.ts has the defaults). */
  studioFiles: { catalog: string | undefined; intents: string | undefined };
  logLevel: Env["LOG_LEVEL"];
  store: { kind: Env["AGENT_STORE"]; databaseUrl: string | undefined; schema: string; autoMigrate: boolean };
  bus: { kind: Env["AGENT_EVENT_BUS"]; redisUrl: string | undefined; streamMaxLen: number; streamTtlS: number };
  cluster: { replicaId: string; leaseS: number; heartbeatS: number; inboxPollMs: number };
  shutdownGraceS: number;
  sweeperEnabled: boolean;
  gitSha: string | undefined;
}

export const SCRIPTED_PROVIDER = "scripted";
/** pi's Vertex AI provider. Its key is the marker pi reads as "use Application Default Credentials". */
export const VERTEX_PROVIDER = "google-vertex";
export const VERTEX_ADC = "gcp-vertex-credentials";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Validate settings. Fails closed in production; in dev, missing keys only disable the feature. */
export function loadConfig(raw: NodeJS.ProcessEnv = process.env): { config: Config; warnings: string[] } {
  const parsed = schema.safeParse(Object.fromEntries(Object.keys(schema.shape).map((k) => [k, env(k, raw)])));
  if (!parsed.success) {
    // Key names and zod's message only: never the offending value (it may be a secret).
    throw new ConfigError(`invalid settings: ${parsed.error.issues.map((i) => `${envName(String(i.path[0]))} (${i.message})`).join("; ")}`);
  }
  const e = parsed.data;
  const warnings: string[] = [];

  const scripted = e.AGENT_MODEL === SCRIPTED_PROVIDER;
  const MODEL = envName("AGENT_MODEL");
  if (scripted && e.ENV === "production") throw new ConfigError(`${MODEL}=scripted is for development and tests only`);
  const [provider, ...rest] = scripted ? [SCRIPTED_PROVIDER, "replay"] : e.AGENT_MODEL.split(":");
  const id = rest.join(":");
  if (!provider || !id) throw new ConfigError(`${MODEL} must be provider:model-id, got "${e.AGENT_MODEL}"`);
  const allowlist = e.AGENT_MODEL_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean);
  if (scripted) allowlist.push(`${provider}:${id}`);
  else if (!allowlist.includes(e.AGENT_MODEL)) throw new ConfigError(`${MODEL} ${e.AGENT_MODEL} is not in ${envName("AGENT_MODEL_ALLOWLIST")}`);

  const providerKeys: Record<string, string> = {};
  if (e.OPENAI_API_KEY) providerKeys.openai = e.OPENAI_API_KEY;
  if (e.ANTHROPIC_API_KEY) providerKeys.anthropic = e.ANTHROPIC_API_KEY;
  const vertex = e.GOOGLE_CLOUD_PROJECT && e.GOOGLE_CLOUD_LOCATION ? { project: e.GOOGLE_CLOUD_PROJECT, location: e.GOOGLE_CLOUD_LOCATION } : undefined;
  if (vertex) providerKeys[VERTEX_PROVIDER] = VERTEX_ADC;

  const missing: string[] = [];
  if (!scripted && !providerKeys[provider])
    missing.push(
      ...(provider === VERTEX_PROVIDER
        ? (["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"] as const).filter((k) => !e[k])
        : [`${provider.toUpperCase()}_API_KEY`]),
    );
  const sandboxOn = e.AGENT_SANDBOX === "daytona";
  if (sandboxOn && !e.DAYTONA_API_KEY) missing.push("DAYTONA_API_KEY");
  if (e.AGENT_SANDBOX === "local" && !e.AGENT_SANDBOX_LOCAL_IMAGE) missing.push(envName("AGENT_SANDBOX_LOCAL_IMAGE"));
  if (e.ENV === "production" && e.AGENT_SANDBOX === "fake") throw new ConfigError(`${envName("AGENT_SANDBOX")}=fake is for development and tests only`);
  if (e.ENV === "production" && e.AGENT_SANDBOX_NETWORK !== "block") throw new ConfigError(`${envName("AGENT_SANDBOX_NETWORK")} must be block in production`);
  // Explicitly chosen backends need their URL in every stage (development included).
  const backend: string[] = [];
  if (e.AGENT_STORE === "postgres" && !e.AGENT_DATABASE_URL) backend.push(envName("AGENT_DATABASE_URL"));
  if (e.AGENT_EVENT_BUS === "redis" && !e.AGENT_REDIS_URL) backend.push(envName("AGENT_REDIS_URL"));
  if (e.ENV === "production") {
    if (!e.AGENT_TOKEN) missing.push(envName("AGENT_TOKEN"));
    missing.push(...backend);
    if (missing.length) throw new ConfigError(`missing required settings: ${missing.join(", ")}`);
  } else {
    if (backend.length) throw new ConfigError(`missing required settings: ${backend.join(", ")}`);
    if (missing.length) warnings.push(`missing ${missing.join(", ")}; the related features are disabled`);
  }

  return {
    warnings,
    config: {
      env: e.ENV,
      host: e.AGENT_HOST,
      port: e.AGENT_PORT,
      serviceToken: e.AGENT_TOKEN,
      model: { provider, id, allowlist, thinking: e.AGENT_THINKING },
      providerKeys,
      vertex,
      daytona: sandboxOn && e.DAYTONA_API_KEY
        ? { apiKey: e.DAYTONA_API_KEY, apiUrl: e.DAYTONA_API_URL, target: e.DAYTONA_TARGET }
        : undefined,
      sandbox: {
        provider: e.AGENT_SANDBOX,
        network: e.AGENT_SANDBOX_NETWORK,
        buildTtlMin: Math.max(1, e.AGENT_SANDBOX_BUILD_TTL_MIN),
        local: { image: e.AGENT_SANDBOX_LOCAL_IMAGE, runtime: e.AGENT_SANDBOX_LOCAL_RUNTIME, cli: e.AGENT_SANDBOX_LOCAL_CLI },
        gke: { namespace: e.AGENT_SANDBOX_GKE_NAMESPACE, template: e.AGENT_SANDBOX_GKE_TEMPLATE, apiServer: `https://${e.KUBERNETES_SERVICE_HOST}:${e.KUBERNETES_SERVICE_PORT}` },
        fakeDir: e.AGENT_SANDBOX_FAKE_DIR,
        autoStopMin: e.AGENT_SANDBOX_AUTO_STOP_MIN,
        autoArchiveMin: e.AGENT_SANDBOX_AUTO_ARCHIVE_MIN,
        autoDeleteMin: e.AGENT_SANDBOX_AUTO_DELETE_MIN,
        ttlMin: e.AGENT_SANDBOX_TTL_MIN,
        snapshot: e.AGENT_SANDBOX_SNAPSHOT,
        execTimeoutS: e.AGENT_EXEC_TIMEOUT_S,
        outputMax: e.AGENT_TOOL_OUTPUT_MAX,
      },
      budgets: {
        maxToolCalls: e.AGENT_MAX_TOOL_CALLS,
        maxRunSeconds: e.AGENT_MAX_RUN_SECONDS,
        maxSpendUsd: e.AGENT_MAX_SPEND_USD,
      },
      clientToolTimeoutS: e.AGENT_CLIENT_TOOL_TIMEOUT_S,
      approvalTimeoutS: e.AGENT_APPROVAL_TIMEOUT_S,
      limits: { maxSessions: e.AGENT_MAX_SESSIONS, maxConcurrentRuns: e.AGENT_MAX_CONCURRENT_RUNS },
      studioUrl: e.WEB_URL,
      kernelUrl: e.API_URL,
      sweep: { retentionDays: e.AGENT_SANDBOX_RETENTION_DAYS, idleStopMin: e.AGENT_SANDBOX_IDLE_STOP_MIN },
      egressProbe: e.AGENT_EGRESS_PROBE,
      script: scripted ? e.AGENT_SCRIPT : undefined,
      dataDir: e.AGENT_DATA_DIR,
      studioFiles: { catalog: e.AGENT_CATALOG_FILE, intents: e.AGENT_INTENTS_FILE },
      logLevel: e.LOG_LEVEL,
      store: { kind: e.AGENT_STORE, databaseUrl: e.AGENT_DATABASE_URL, schema: e.AGENT_DATABASE_SCHEMA, autoMigrate: e.AGENT_AUTO_MIGRATE },
      bus: { kind: e.AGENT_EVENT_BUS, redisUrl: e.AGENT_REDIS_URL, streamMaxLen: Math.max(100, e.AGENT_RUN_STREAM_MAXLEN), streamTtlS: e.AGENT_RUN_STREAM_TTL_S },
      cluster: {
        // Unique per process: a restarted container keeps its HOSTNAME but must not own the old runs.
        replicaId: e.AGENT_REPLICA_ID ?? `${e.HOSTNAME || "agent"}-${randomBytes(3).toString("hex")}`,
        leaseS: Math.max(2, e.AGENT_RUN_LEASE_S),
        heartbeatS: Math.max(1, Math.min(e.AGENT_RUN_HEARTBEAT_S, Math.floor(e.AGENT_RUN_LEASE_S / 2) || 1)),
        inboxPollMs: Math.max(100, e.AGENT_INBOX_POLL_MS),
      },
      shutdownGraceS: e.AGENT_SHUTDOWN_GRACE_S,
      sweeperEnabled: e.AGENT_SWEEPER_ENABLED,
      gitSha: e.GIT_SHA,
    },
  };
}

/** One line per secret: presence and last 3 characters only. */
export function describeSecrets(config: Config): string {
  return [
    `openai=${maskSecret(config.providerKeys.openai)}`,
    `anthropic=${maskSecret(config.providerKeys.anthropic)}`,
    `vertex=${config.vertex ? "adc" : "unset"}`,
    `daytona=${maskSecret(config.daytona?.apiKey)}`,
    `serviceToken=${maskSecret(config.serviceToken)}`,
  ].join(" ");
}
