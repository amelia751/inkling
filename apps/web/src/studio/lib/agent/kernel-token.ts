import { apiUrl, runtimeConfig } from "@/extension-host/runtime-config";
import type { ProfileName } from "@studio/agent-protocol";
import { apiFetch } from "@/extension-host/http";
import { personSuffix } from "@/studio/lib/person-key";

/**
 * Kernel session tokens for the agent (docs/plugins.md §8). The Studio, acting as the signed-in
 * user, mints a narrower token bound to this project and hands it to the agent service with each
 * message; the agent never holds the user's own credentials. Every profile reads its project and
 * may create proposals (todo6 Phase 6: `proposals.write`, never confirm: the kernel only lets a
 * person confirm); builder and task add their own. Scopes mirror `KERNEL_SCOPES` in
 * apps/agent/src/tools/kernel.ts. None includes `plugins.approve`: installs are approved by the
 * user in the install review, never by the agent.
 */
export const KERNEL_SCOPES: Record<ProfileName, string[]> = {
  // The one assistant: reads and changes the project, runs installed capabilities (each run approved in the chat).
  assistant: ["proposals.write", "project.write", "assets.read", "assets.write", "annotations.read", "commands.invoke", "versioning.read", "versioning.write", "versioning.review", "versioning.checkout"],
  "environment-designer": ["proposals.write"],
  // samples.*: the data-boundary routes (todo10 Phase 7): fingerprints and fixtures; builders also verify and probe.
  coder: ["proposals.write", "samples.inspect"],
  builder: ["plugins.read", "plugins.manage", "plugins.author", "proposals.write", "samples.inspect", "samples.verify"],
  task: ["proposals.write", "project.write", "assets.read", "assets.write", "annotations.read", "commands.invoke", "versioning.read", "versioning.write", "versioning.review", "versioning.checkout"],
  // todo21 D8: Home only lists projects and checks access to one (open_in_project); no data scopes.
  home: [],
  // todo23 W3: the scout reads only public package metadata; no project data scopes.
  scout: [],
};

const TTL_S = 3600;
/** Keyed by person + organization (personSuffix) + workspace + profile; `forgetClient` clears it. */
const cache = new Map<string, { token: string; expiresAt: number }>();

/** Drop every cached token (sign-out, organization switch). */
export function clearKernelTokens(): void {
  cache.clear();
}

/** A token for this workspace and profile, reused until 10 minutes before it expires; undefined if the kernel isn't reachable. */
export async function kernelToken(workspaceId: string, profile: ProfileName): Promise<string | undefined> {
  const scopes = KERNEL_SCOPES[profile];
  // Without the kernel (the dev seed server) there is nothing to mint a token from.
  if (!scopes || !runtimeConfig().kernel) return undefined;
  const key = `${personSuffix()}|${workspaceId}:${profile}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt - Date.now() > 10 * 60_000) return hit.token;
  try {
    const res = await apiFetch(apiUrl("/v1/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": workspaceId },
      body: JSON.stringify({ agent: profile, profile, scopes, ttlSeconds: TTL_S }),
    });
    if (!res.ok) return undefined;
    const { token } = (await res.json()) as { token: string };
    cache.set(key, { token, expiresAt: Date.now() + TTL_S * 1000 });
    return token;
  } catch {
    return undefined;
  }
}
