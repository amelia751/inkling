import type { EnvironmentSpec } from "@studio/contracts/environment";
import type { PluginsLock } from "@studio/contracts/lockfile";
import { apiUrl } from "@/extension-host/runtime-config";

/**
 * Safe mode and rollback (todo10 §3.4, Phase 4). `?safe` boots the task from its
 * `last-known-good` setup (environment + lockfile) with only first-party plugins, like VS Code's
 * "disable extensions"; rollback restores that setup for real, in one kernel transaction. Neither
 * calls a model. Without a known-good setup (or without the kernel) safe mode boots the task's
 * manifest environment.
 */

export interface KnownGood {
  revision: number;
  environment: EnvironmentSpec | null;
  contentHash: string;
  lockfile: PluginsLock;
  lockfileHash: string;
  movedBy: string;
  movedBecause: "person" | "checks";
  movedAt: string;
}

export const isSafeMode = (search: string): boolean => new URLSearchParams(search).has("safe");

/** The current Studio URL in (or out of) safe mode. Followed as a full page load: the registry starts clean. */
export function safeHref(on: boolean): string {
  const u = new URL(window.location.href);
  if (on) u.searchParams.set("safe", "");
  else u.searchParams.delete("safe");
  return u.pathname + u.search + u.hash;
}

const env = (id: string, sub: string) => apiUrl(`/environments/${encodeURIComponent(id)}/${sub}`);
const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function json<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as { error?: unknown; detail?: unknown };
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : typeof data.detail === "string" ? data.detail : `${res.status} ${res.statusText}`);
  return data as T;
}

/** The task's last-known-good setup, or null when it has none (or nothing serves it). */
export async function fetchKnownGood(taskId: string): Promise<KnownGood | null> {
  const res = await fetch(env(taskId, "last-known-good"));
  if (res.status === 404 || !(res.headers.get("content-type") ?? "").includes("json")) return null;
  return json<KnownGood>(res);
}

export interface RollbackResult {
  revision: number | null;
  contentHash: string;
  lockfileHash: string;
  plugins: { disabled: string[]; restored: string[]; unchanged: string[]; refused: { id: string; reason: string }[] };
}

export const rollback = async (taskId: string) => json<RollbackResult>(await send(env(taskId, "rollback"), "POST"));

export const markKnownGood = async (taskId: string, revision?: number) =>
  json<{ moved: boolean; reason?: string; knownGood?: KnownGood }>(await send(env(taskId, "last-known-good"), "PUT", revision === undefined ? {} : { revision }));

/** After a clean boot: passing checks may move last-known-good (never to an agent's change). */
export async function reportCleanBoot(taskId: string, revision: number, contentHash: string | undefined): Promise<void> {
  await send(env(taskId, "checks"), "POST", { revision, contentHash, ok: true }).catch(() => undefined);
}
