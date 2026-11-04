// The one place this server reads the environment: `<envPrefix><KEY>` (prefix from schemas/naming.json).
import { readFileSync } from "node:fs";

export type Naming = { envPrefix: string; resourcePrefix: string; displayName: string };

export const NAMING: Naming = JSON.parse(readFileSync(new URL("../../../schemas/naming.json", import.meta.url), "utf8"));

export interface McpConfig {
  /**
   * Where /api/environments, /api/catalog and /seed are read (todo17 M0): `<envPrefix>MCP_STUDIO_URL`,
   * else `<envPrefix>WEB_URL` (older setups pointed at the web dev server, which proxies /api), else
   * `<envPrefix>API_URL`, else the api's dev URL (http://127.0.0.1:8000).
   */
  webUrl: string;
  /** The kernel's Workspace and Plugin APIs (default: `<envPrefix>API_URL`, else the URL above). */
  apiUrl: string;
  /** Kernel workspace whose active plugins are offered as MCP Apps viewers. */
  workspace: string | undefined;
  /**
   * Organization API key (todo9 Phase 8), sent as `Authorization: Bearer` on every API call. The API
   * then knows who edits, so `author` is no longer sent. stdio only: over HTTP the caller's token is used.
   */
  apiKey: string | undefined;
  /** todo16: a person's token for the kernel tools (default: the API key). The kernel applies their project role. */
  personToken: string | undefined;
  /** Dev fallback without a key: the author name saved with environment edits. */
  author: string;
  /** todo17 D12: `stdio` (default; `--http` on the command line also picks http) or `http` (streamable HTTP). */
  transport: "stdio" | "http";
  /** HTTP listen address (`MCP_HOST`, `MCP_PORT`). */
  host: string;
  port: number;
  /** Public URL of the remote MCP endpoint, e.g. `https://mcp.example.com/mcp`: the OAuth resource (audience). */
  publicUrl: string;
  /** The OAuth authorization server (the WorkOS AuthKit domain, `https://<sub>.authkit.app`). */
  authServer: string | undefined;
  /** Calls per token per minute, and writes per token per day (todo17 D12). */
  rateLimitPerMin: number;
  writeQuotaPerDay: number;
  /** Redis for the rate-limit counters (replica-safe). Unset: in-process counters (one replica only). */
  redisUrl: string | undefined;
  /** PEM of the CA that signs Redis's TLS certificate (`rediss://` on Memorystore). */
  redisCaFile: string | undefined;
  /** Image build's git sha (`--build-arg GIT_SHA`), served by /version. */
  gitSha: string | undefined;
  /** todo23 W10: the agent service (`<envPrefix>AGENT_URL`, default its dev port) for the scout tools. */
  agentUrl: string;
  /** The agent service token (`<envPrefix>AGENT_TOKEN`); the scout tools are off without it. */
  agentToken: string | undefined;
}

/** The api's dev URL (`pnpm dev`, docs/running.md). */
export const DEFAULT_STUDIO_URL = "http://127.0.0.1:8000";
export const DEFAULT_PORT = 8300;
/** The agent service's dev URL (apps/agent `AGENT_PORT`). */
export const DEFAULT_AGENT_URL = "http://127.0.0.1:8100";

/** Configuration is missing or invalid; the message names keys, never values. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

const int = (v: string | undefined, d: number) => {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function loadConfig(raw: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): McpConfig {
  const env = (key: string) => raw[`${NAMING.envPrefix}${key}`] || undefined;
  const webUrl = (env("MCP_STUDIO_URL") ?? env("WEB_URL") ?? env("API_URL") ?? DEFAULT_STUDIO_URL).replace(/\/$/, "");
  const host = env("MCP_HOST") ?? "127.0.0.1";
  const port = int(env("MCP_PORT"), DEFAULT_PORT);
  const transport = env("MCP_TRANSPORT") === "http" || argv.includes("--http") ? "http" : "stdio";
  // todo22 D2: the remote server in production signs callers in with OAuth (todo17 D12), so it needs
  // its public resource URL and the authorization server; without them it refuses to start. stdio
  // stays a local tool. Key names only, never values.
  if (transport === "http" && env("ENV") === "production") {
    const need = ["MCP_PUBLIC_URL", "MCP_AUTH_SERVER"].filter((key) => !env(key));
    if (need.length) throw new ConfigError(`missing required settings: ${need.map((key) => `${NAMING.envPrefix}${key}`).join(", ")}`);
  }
  return {
    webUrl,
    apiUrl: (env("API_URL") ?? webUrl).replace(/\/$/, ""),
    workspace: env("MCP_WORKSPACE"),
    apiKey: env("MCP_API_KEY"),
    personToken: env("MCP_PERSON_TOKEN"),
    author: env("MCP_AUTHOR") ?? "agent:mcp",
    transport,
    host,
    port,
    publicUrl: (env("MCP_PUBLIC_URL") ?? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/mcp`).replace(/\/$/, ""),
    authServer: env("MCP_AUTH_SERVER")?.replace(/\/$/, ""),
    rateLimitPerMin: int(env("MCP_RATE_LIMIT_PER_MIN"), 120),
    writeQuotaPerDay: int(env("MCP_WRITE_QUOTA_PER_DAY"), 5000),
    redisUrl: env("MCP_REDIS_URL"),
    redisCaFile: env("MCP_REDIS_CA_FILE"),
    gitSha: raw.GIT_SHA || undefined,
    agentUrl: (env("AGENT_URL") ?? DEFAULT_AGENT_URL).replace(/\/$/, ""),
    agentToken: env("AGENT_TOKEN"),
  };
}

/** Headers every API call carries: the API key when one is configured. */
export const authHeaders = (config: Pick<McpConfig, "apiKey">): Record<string, string> =>
  config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
