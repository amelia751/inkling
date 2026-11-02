// The one place this server reads the environment: `<envPrefix><KEY>` (prefix from schemas/naming.json).
import { readFileSync } from "node:fs";

export type Naming = { envPrefix: string; resourcePrefix: string; displayName: string };

export const NAMING: Naming = JSON.parse(readFileSync(new URL("../../../schemas/naming.json", import.meta.url), "utf8"));

export interface McpConfig {
  /** The Studio (web dev server or the deployed web), which serves /api/environments and the catalogue. */
  webUrl: string;
  /** The kernel's Workspace and Plugin APIs (default: the web URL, which proxies /api). */
  apiUrl: string;
  /** Kernel workspace whose active plugins are offered as MCP Apps viewers. */
  workspace: string | undefined;
  /**
   * Organization API key (todo9 Phase 8), sent as `Authorization: Bearer` on every API call. The API
   * then knows who edits, so `author` is no longer sent.
   */
  apiKey: string | undefined;
  /** todo16: a person's token for the kernel tools (default: the API key). The kernel applies their project role. */
  personToken: string | undefined;
  /** Dev fallback without a key: the author name saved with environment edits. */
  author: string;
}

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): McpConfig {
  const env = (key: string) => raw[`${NAMING.envPrefix}${key}`] || undefined;
  const webUrl = (env("WEB_URL") ?? "http://localhost:5173").replace(/\/$/, "");
  return {
    webUrl,
    apiUrl: (env("API_URL") ?? webUrl).replace(/\/$/, ""),
    workspace: env("MCP_WORKSPACE"),
    apiKey: env("MCP_API_KEY"),
    personToken: env("MCP_PERSON_TOKEN"),
    author: env("MCP_AUTHOR") ?? "agent:mcp",
  };
}

/** Headers every API call carries: the API key when one is configured. */
export const authHeaders = (config: Pick<McpConfig, "apiKey">): Record<string, string> =>
  config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
