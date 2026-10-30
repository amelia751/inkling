import type { ProfileName } from "./protocol";

/**
 * Kernel session tokens for the builder and task agent profiles (docs/plugins.md §8). The Studio,
 * acting as the signed-in user, mints a narrower token bound to this workspace and hands it to
 * the agent service with each message; the agent never holds the user's own credentials. Scopes
 * mirror `KERNEL_SCOPES` in apps/agent/src/tools/kernel.ts. Neither includes `plugins.approve`:
 * installs are approved by the user in the install review, never by the agent.
 */
export const KERNEL_SCOPES: Partial<Record<ProfileName, string[]>> = {
  builder: ["plugins.read", "plugins.manage", "plugins.author"],
  task: ["assets.read", "assets.write", "annotations.read", "commands.invoke", "versioning.read", "versioning.write", "versioning.review", "versioning.checkout"],
};

const TTL_S = 3600;
const cache = new Map<string, { token: string; expiresAt: number }>();

/** A token for this workspace and profile, reused until 10 minutes before it expires; undefined if the kernel isn't reachable. */
export async function kernelToken(workspaceId: string, profile: ProfileName): Promise<string | undefined> {
  const scopes = KERNEL_SCOPES[profile];
  if (!scopes) return undefined;
  const key = `${workspaceId}:${profile}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt - Date.now() > 10 * 60_000) return hit.token;
  try {
    const res = await fetch("/api/v1/sessions", {
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
