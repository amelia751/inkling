import { activePluginIds, WorkspaceState, type WorkspaceState as WorkspaceStateT } from "@studio/plugin-contracts/workspace";
import { registry, type ActivationResult } from "./registry";

/**
 * Per-workspace activation (todo2 Phase 3, docs/plugins.md §14 #1): the registry knows every
 * bundled plugin, but a Studio runs only those its workspace has ACTIVATED (plus the pinned
 * built-ins). The state comes from the kernel's Workspace API, or in dev from the seed
 * server (seed-data/<project>/workspace.json); no state means "all bundled plugins".
 */
export async function fetchWorkspaceState(workspaceId: string): Promise<WorkspaceStateT | null> {
  const res = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/state`, { headers: { "X-Workspace-Id": workspaceId } });
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
