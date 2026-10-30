import { activePluginIds, WorkspaceState, type WorkspaceState as WorkspaceStateT } from "@studio/contracts/workspace";
import { PluginManifest } from "@studio/contracts/plugin-manifest";
import { UiContributions } from "@studio/contracts/ui-contributions";
import { declarativeModule } from "./contributions-loader";
import { registry, type ActivationResult } from "./registry";
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
    const res = await fetch(apiUrl(`/v1/plugins/${encodeURIComponent(id)}?version=${encodeURIComponent(inst?.version ?? "")}`), { headers: { "X-Workspace-Id": state.workspaceId } });
    if (!res.ok) continue;
    const body = (await res.json()) as { manifest: unknown; contributions?: unknown };
    const m = PluginManifest.safeParse(body.manifest);
    if (!m.success || m.data.ui?.module || !body.contributions) continue;
    const ui = UiContributions.safeParse(body.contributions);
    if (!ui.success) continue;
    registry.registerModule(declarativeModule(m.data, ui.data));
    added.push(id);
  }
  return added;
}
