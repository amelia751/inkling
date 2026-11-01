import { activePluginIds, WorkspaceState, type WorkspaceState as WorkspaceStateT } from "@studio/contracts/workspace";
import { PluginManifest } from "@studio/contracts/plugin-manifest";
import { UiContributions } from "@studio/contracts/ui-contributions";
import yaml from "js-yaml";
import { declarativeModule, verifyPackage, type PackageFiles } from "./contributions-loader";
import { registry, type ActivationResult } from "./registry";
import { MODULES } from "./bundled";
import { firstPartyIds, type PluginsLock } from "@studio/contracts/lockfile";
import { apiUrl } from "./runtime-config";

/**
 * Per-workspace activation (todo2 Phase 3, docs/plugins.md §14 #1): the registry knows every
 * bundled plugin, but a Studio runs only those its workspace has ACTIVATED (plus the pinned
 * built-ins). The state comes from the kernel's Workspace API, or in dev from the seed
 * server (seed-data/<project>/workspace.json); no state means "all bundled plugins".
 */
export async function fetchWorkspaceState(workspaceId: string): Promise<WorkspaceStateT | null> {
  const res = await fetch(apiUrl(`/v1/workspaces/${encodeURIComponent(workspaceId)}/state`), { headers: { "X-Workspace-Id": workspaceId } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`workspace state: ${res.status} ${res.statusText}`);
  const parsed = WorkspaceState.safeParse(await res.json());
  if (!parsed.success) throw new Error(`workspace state is invalid: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** Activate exactly the workspace's plugins (null: all bundled). Unknown ids are ignored; missing requirements reported. */
export function applyWorkspace(state: WorkspaceStateT | null): ActivationResult {
  return registry.setActive(state ? activePluginIds(state) : null);
}

/**
 * Safe mode (todo10 §3.4): only first-party plugins this build bundles, never a remote one.
 * With a last-known-good lockfile, those it locks as first-party; otherwise the workspace's
 * active ones (all bundled ones without a workspace state).
 */
export function applySafeWorkspace(state: WorkspaceStateT | null, lock: PluginsLock | null): ActivationResult {
  const bundled = new Set(MODULES.map((m) => m.id));
  const wanted = lock ? firstPartyIds(lock) : state ? activePluginIds(state) : [...bundled];
  return registry.setActive(wanted.filter((id) => bundled.has(id)));
}

/**
 * Register active plugins this build doesn't bundle, from their data-only manifests on the
 * kernel (docs/plugins.md Phase 1 exit: activation without a web deploy). Only declarative
 * UI is accepted this way; a plugin that ships trusted code (ui.module) must be bundled.
 */
export async function loadRemotePlugins(state: WorkspaceStateT | null): Promise<string[]> {
  if (!state) return [];
  const added: string[] = [];
  for (const id of activePluginIds(state)) {
    if (registry.availableModule(id)) continue;
    const inst = state.plugins.find((p) => p.pluginId === id);
    // Fetch-and-hash (todo10 Phase 3): only bytes that hash to the workspace's pin are used.
    const headers = { "X-Workspace-Id": state.workspaceId };
    const res = await fetch(apiUrl(`/v1/plugins/${encodeURIComponent(id)}/files?version=${encodeURIComponent(inst?.version ?? "")}&include=plugin.yaml`), { headers });
    if (!res.ok) continue;
    const checked = await verifyPackage((await res.json()) as PackageFiles, inst?.artifactDigest);
    if (!checked.ok) {
      console.warn(`[plugins] refused ${id}@${inst?.version}: ${checked.reason}`);
      void fetch(apiUrl(`/v1/workspaces/${encodeURIComponent(state.workspaceId)}/plugins/load-refused`), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ pluginId: id, version: inst?.version, reason: checked.reason, expected: checked.expected, got: checked.got }),
      }).catch(() => undefined);
      continue;
    }
    let raw: unknown;
    try {
      raw = yaml.load(checked.files["plugin.yaml"] ?? "", { schema: yaml.JSON_SCHEMA });
    } catch {
      continue;
    }
    const m = PluginManifest.safeParse(raw);
    const rel = m.success ? m.data.ui?.contributions : undefined;
    if (!m.success || m.data.ui?.module || !rel || checked.files[rel] === undefined) continue;
    let contributions: unknown;
    try {
      contributions = JSON.parse(checked.files[rel]);
    } catch {
      continue;
    }
    const ui = UiContributions.safeParse(contributions);
    if (!ui.success) continue;
    registry.registerModule(declarativeModule(m.data, ui.data));
    added.push(id);
  }
  return added;
}
