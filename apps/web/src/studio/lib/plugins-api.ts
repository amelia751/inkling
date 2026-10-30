/**
 * Client for the kernel's control plane (apps/api, docs/plugins.md §7): registry search,
 * install plans, approval, disable, rollback. Every call names the workspace in the URL and
 * the X-Workspace-Id header; the kernel decides what this principal may do.
 */

export interface PluginSummary {
  id: string;
  version: string;
  name?: string;
  description?: string;
  publisher: string;
  trustTier: "builtin" | "first-party" | "vetted" | "generated";
  runtime: string;
  capabilities: string[];
  mediaTypes: string[];
  permissions: { required: string[]; optional: string[] };
  providers: string[];
  licenses: Record<string, unknown>;
  costHints: Record<string, { unit: string; usdPerUnit: number; effectiveAt: string; sourceUrl: string }>;
}

export interface PlanItem {
  id: string;
  version: string;
  artifactDigest: string;
  trustTier: string;
  runtime: string;
  newCode: boolean;
  modules: string[];
  permissions: { required: string[]; optional: string[]; alreadyGranted: string[] };
  secrets: string[];
  egress: string[];
  providers: { id: string; hosting?: string; pricing?: { unit: string; usdPerUnit: number; effectiveAt: string; sourceUrl: string }; modelLicense?: string; serviceTerms?: string }[];
  estimatedSpend: { defaultBudgetUsdPerJob?: number; maxBudgetUsdPerJob?: number };
  dataResidency: string[];
  uiSurfaces: string[];
  licenses: Record<string, unknown>;
}

export interface InstallRequest {
  requestId: string;
  pluginId: string;
  version: string;
  state: string;
  plan: { target: string; install: PlanItem[]; errors: { code: string; message: string }[]; conflicts: { plugin: string; message: string }[]; risk: "low" | "high" };
  checks: Record<string, unknown>;
}

export interface InstalledPlugin {
  pluginId: string;
  version: string;
  state: string;
  configRevision: number;
  name?: string;
  versions: string[];
  config: Record<string, unknown>;
  permissions: { requested: { required: string[]; optional: string[] }; granted: string[]; used: string[] };
}

async function call<T>(workspaceId: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Workspace-Id": workspaceId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data as { detail?: unknown }).detail;
    throw new Error(typeof detail === "string" ? detail : typeof detail === "object" && detail && "message" in detail ? String((detail as { message: unknown }).message) : `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export const searchPlugins = (workspaceId: string, q = "") => call<{ plugins: PluginSummary[] }>(workspaceId, "GET", `/plugins${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.plugins);
export const installedPlugins = (workspaceId: string) => call<{ plugins: InstalledPlugin[]; history: { pluginId: string; version: string; state: string; actor: string; at: string }[] }>(workspaceId, "GET", `/workspaces/${workspaceId}/plugins`);
export const planInstall = (workspaceId: string, pluginId: string, version?: string) => call<InstallRequest>(workspaceId, "POST", `/workspaces/${workspaceId}/plugins/plan`, { pluginId, version });
export const stageInstall = (workspaceId: string, requestId: string) => call<InstallRequest>(workspaceId, "POST", `/workspaces/${workspaceId}/plugins/stage`, { requestId });
export const approveInstall = (workspaceId: string, requestId: string, grantOptional: string[]) => call<InstallRequest>(workspaceId, "POST", `/workspaces/${workspaceId}/plugins/approve`, { requestId, grantOptional });
export const rejectInstall = (workspaceId: string, requestId: string) => call<InstallRequest>(workspaceId, "POST", `/workspaces/${workspaceId}/plugins/reject`, { requestId });
export const disablePlugin = (workspaceId: string, pluginId: string) => call<unknown>(workspaceId, "POST", `/workspaces/${workspaceId}/plugins/disable`, { pluginId });
export const rollbackPlugin = (workspaceId: string, pluginId: string) => call<unknown>(workspaceId, "POST", `/workspaces/${workspaceId}/plugins/rollback`, { pluginId });
