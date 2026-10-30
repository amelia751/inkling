import { randomBytes } from "node:crypto";
import { z } from "zod";
import { maskSecret } from "./secrets.ts";

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
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  AGENT_HOST: z.string().default("127.0.0.1"),
  AGENT_PORT: int(8100),
  INTERNAL_AGENT_SERVICE_TOKEN: optional,

  AGENT_MODEL: z.string().default("openai:gpt-6.1-sol"),
  AGENT_MODEL_ALLOWLIST: z
    .string()
    .default("openai:gpt-6.1-sol,openai:gpt-6-sol,anthropic:claude-sonnet-5-5,anthropic:claude-opus-5-5"),
  AGENT_THINKING: z.enum(["off", "minimal", "low", "medium", "high"]).default("low"),
  OPENAI_API_KEY: optional,
  ANTHROPIC_API_KEY: optional,

  /** `off` disables sandboxes even when a Daytona key is present (e2e, offline dev). */
  AGENT_SANDBOX: z.enum(["daytona", "off"]).default("daytona"),
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

  /** The Studio (Vite dev server) for the seed API fallback and sample uploads. */
  AGENT_STUDIO_URL: z.string().url().default("http://localhost:5173"),
  /** The kernel (apps/api) for the builder and task profiles' tools; calls there carry `traceparent` / `x-request-id`. */
  AGENT_KERNEL_URL: z.string().url().default("http://127.0.0.1:8000"),
  AGENT_UPLOAD_MAX_FILES: int(20),
  AGENT_UPLOAD_MAX_MB: int(200),
  AGENT_SANDBOX_RETENTION_DAYS: int(7),
  AGENT_SANDBOX_IDLE_STOP_MIN: int(30),
  /** `auto`: probe once (cached a day) whether the org may set egress rules; `off`: assume not. */
  AGENT_EGRESS_PROBE: z.enum(["auto", "off"]).default("auto"),
  /** Fixture for AGENT_MODEL=scripted (dev/test only): a JSON array of scripted assistant turns. */
  AGENT_SCRIPT: optional,
  AGENT_DATA_DIR: optional,

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
  SWEEPER_ENABLED: flag(true),
  /** Injected at image build (`--build-arg GIT_SHA`); served by GET /version. */
  GIT_SHA: optional,
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
});

export type Env = z.infer<typeof schema>;

export interface Config {
  env: Env["APP_ENV"];
  host: string;
  port: number;
  serviceToken: string | undefined;
  model: { provider: string; id: string; allowlist: string[]; thinking: Env["AGENT_THINKING"] };
  providerKeys: Record<string, string>;
  daytona: { apiKey: string; apiUrl: string; target: string | undefined } | undefined;
  sandbox: {
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
  upload: { maxFiles: number; maxBytes: number };
  sweep: { retentionDays: number; idleStopMin: number };
  egressProbe: "auto" | "off";
  /** Set when AGENT_MODEL=scripted: path of the replay fixture. */
  script: string | undefined;
  dataDir: string | undefined;
  logLevel: Env["LOG_LEVEL"];
  store: { kind: Env["AGENT_STORE"]; databaseUrl: string | undefined; schema: string; autoMigrate: boolean };
  bus: { kind: Env["AGENT_EVENT_BUS"]; redisUrl: string | undefined; streamMaxLen: number; streamTtlS: number };
  cluster: { replicaId: string; leaseS: number; heartbeatS: number; inboxPollMs: number };
  shutdownGraceS: number;
  sweeperEnabled: boolean;
  gitSha: string | undefined;
}

export const SCRIPTED_PROVIDER = "scripted";

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Validate settings. Fails closed in production; in dev, missing keys only disable the feature. */
export function loadConfig(raw: NodeJS.ProcessEnv = process.env): { config: Config; warnings: string[] } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Key names and zod's message only: never the offending value (it may be a secret).
    throw new ConfigError(`invalid settings: ${parsed.error.issues.map((i) => `${i.path.join(".")} (${i.message})`).join("; ")}`);
  }
  const e = parsed.data;
  const warnings: string[] = [];

  const scripted = e.AGENT_MODEL === SCRIPTED_PROVIDER;
  if (scripted && e.APP_ENV === "production") throw new ConfigError("AGENT_MODEL=scripted is for development and tests only");
  const [provider, ...rest] = scripted ? [SCRIPTED_PROVIDER, "replay"] : e.AGENT_MODEL.split(":");
  const id = rest.join(":");
  if (!provider || !id) throw new ConfigError(`AGENT_MODEL must be provider:model-id, got "${e.AGENT_MODEL}"`);
  const allowlist = e.AGENT_MODEL_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean);
  if (scripted) allowlist.push(`${provider}:${id}`);
  else if (!allowlist.includes(e.AGENT_MODEL)) throw new ConfigError(`AGENT_MODEL ${e.AGENT_MODEL} is not in AGENT_MODEL_ALLOWLIST`);

  const providerKeys: Record<string, string> = {};
  if (e.OPENAI_API_KEY) providerKeys.openai = e.OPENAI_API_KEY;
  if (e.ANTHROPIC_API_KEY) providerKeys.anthropic = e.ANTHROPIC_API_KEY;

  const missing: string[] = [];
  if (!scripted && !providerKeys[provider]) missing.push(`${provider.toUpperCase()}_API_KEY`);
  const sandboxOn = e.AGENT_SANDBOX === "daytona";
  if (sandboxOn && !e.DAYTONA_API_KEY) missing.push("DAYTONA_API_KEY");
  // Explicitly chosen backends need their URL in every environment.
  const backend: string[] = [];
  if (e.AGENT_STORE === "postgres" && !e.AGENT_DATABASE_URL) backend.push("AGENT_DATABASE_URL");
  if (e.AGENT_EVENT_BUS === "redis" && !e.AGENT_REDIS_URL) backend.push("AGENT_REDIS_URL");
  if (e.APP_ENV === "production") {
    if (!e.INTERNAL_AGENT_SERVICE_TOKEN) missing.push("INTERNAL_AGENT_SERVICE_TOKEN");
    missing.push(...backend);
    if (missing.length) throw new ConfigError(`missing required settings: ${missing.join(", ")}`);
  } else {
    if (backend.length) throw new ConfigError(`missing required settings: ${backend.join(", ")}`);
    if (missing.length) warnings.push(`missing ${missing.join(", ")}; the related features are disabled`);
  }

  return {
    warnings,
    config: {
      env: e.APP_ENV,
      host: e.AGENT_HOST,
      port: e.AGENT_PORT,
      serviceToken: e.INTERNAL_AGENT_SERVICE_TOKEN,
      model: { provider, id, allowlist, thinking: e.AGENT_THINKING },
      providerKeys,
      daytona: sandboxOn && e.DAYTONA_API_KEY
        ? { apiKey: e.DAYTONA_API_KEY, apiUrl: e.DAYTONA_API_URL, target: e.DAYTONA_TARGET }
        : undefined,
      sandbox: {
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
      studioUrl: e.AGENT_STUDIO_URL,
      kernelUrl: e.AGENT_KERNEL_URL,
      upload: { maxFiles: e.AGENT_UPLOAD_MAX_FILES, maxBytes: e.AGENT_UPLOAD_MAX_MB * 1024 * 1024 },
      sweep: { retentionDays: e.AGENT_SANDBOX_RETENTION_DAYS, idleStopMin: e.AGENT_SANDBOX_IDLE_STOP_MIN },
      egressProbe: e.AGENT_EGRESS_PROBE,
      script: scripted ? e.AGENT_SCRIPT : undefined,
      dataDir: e.AGENT_DATA_DIR,
      logLevel: e.LOG_LEVEL,
      store: { kind: e.AGENT_STORE, databaseUrl: e.AGENT_DATABASE_URL, schema: e.AGENT_DATABASE_SCHEMA, autoMigrate: e.AGENT_AUTO_MIGRATE },
      bus: { kind: e.AGENT_EVENT_BUS, redisUrl: e.AGENT_REDIS_URL, streamMaxLen: Math.max(100, e.AGENT_RUN_STREAM_MAXLEN), streamTtlS: e.AGENT_RUN_STREAM_TTL_S },
      cluster: {
        // Unique per process: a restarted container keeps its HOSTNAME but must not own the old runs.
        replicaId: e.AGENT_REPLICA_ID ?? `${raw.HOSTNAME || "agent"}-${randomBytes(3).toString("hex")}`,
        leaseS: Math.max(2, e.AGENT_RUN_LEASE_S),
        heartbeatS: Math.max(1, Math.min(e.AGENT_RUN_HEARTBEAT_S, Math.floor(e.AGENT_RUN_LEASE_S / 2) || 1)),
        inboxPollMs: Math.max(100, e.AGENT_INBOX_POLL_MS),
      },
      shutdownGraceS: e.AGENT_SHUTDOWN_GRACE_S,
      sweeperEnabled: e.SWEEPER_ENABLED,
      gitSha: e.GIT_SHA,
    },
  };
}

/** One line per secret: presence and last 3 characters only. */
export function describeSecrets(config: Config): string {
  return [
    `openai=${maskSecret(config.providerKeys.openai)}`,
    `anthropic=${maskSecret(config.providerKeys.anthropic)}`,
    `daytona=${maskSecret(config.daytona?.apiKey)}`,
    `serviceToken=${maskSecret(config.serviceToken)}`,
  ].join(" ");
}
