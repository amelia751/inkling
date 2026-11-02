import type { HostStore } from "@studio/plugin-ui-sdk";
import { setGatewayTransport, type GatewayResult } from "./gateway";
import { apiUrl, runtimeConfig } from "./runtime-config";
import { apiFetch } from "./http";

/**
 * Talking to the kernel (apps/api, todo2 Phase 4). Enabled by the runtime config (`kernel` in
 * /config.json; in dev `<envPrefix>API_URL=http://127.0.0.1:8000 pnpm dev`, which proxies /api
 * to it); otherwise the dev seed server stands in and only local command handlers run.
 *
 * - Plugin commands go to `POST /api/v1/commands` (the command gateway); worker jobs are
 *   polled until they finish, and the annotations they committed are merged into the store.
 * - Asset URLs are signed by the kernel's Asset API (a workspace URL token, refreshed
 *   before it expires) instead of pointing at /seed.
 */
export const kernelEnabled = (): boolean => runtimeConfig().kernel;

const headers = (workspaceId: string) => ({ "Content-Type": "application/json", "X-Workspace-Id": workspaceId });

interface UrlToken {
  workspaceId: string;
  exp: number;
  sig: string;
  base: string;
}
let urlToken: UrlToken | null = null;

/** Fetch (or refresh) the workspace URL token; call when a project opens. */
export async function prepareAssetUrls(workspaceId: string): Promise<void> {
  if (!kernelEnabled()) return;
  const res = await apiFetch(apiUrl("/v1/assets/url-token"), { method: "POST", headers: headers(workspaceId) });
  if (res.ok) urlToken = (await res.json()) as UrlToken;
  const ttl = urlToken ? urlToken.exp * 1000 - Date.now() : 0;
  if (ttl > 0) setTimeout(() => urlToken?.workspaceId === workspaceId && void prepareAssetUrls(workspaceId), Math.max(10_000, ttl - 60_000));
}

/** Signed kernel URL for an asset path when one is available, else the dev seed path. */
export function kernelAssetUrl(path: string): string | null {
  if (!urlToken || urlToken.exp * 1000 < Date.now()) return null;
  return `${urlToken.base}${path.split("/").map(encodeURIComponent).join("/")}?exp=${urlToken.exp}&sig=${urlToken.sig}`;
}

interface Job {
  jobId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  error?: string;
  result?: { annotationIds?: string[] };
}

async function waitForJob(workspaceId: string, job: Job, onProgress?: (j: Job) => void): Promise<Job> {
  let j = job;
  for (let delay = 300; j.state === "queued" || j.state === "running"; delay = Math.min(delay * 1.5, 3000)) {
    await new Promise((r) => setTimeout(r, delay));
    const res = await apiFetch(apiUrl(`/v1/jobs/${j.jobId}`), { headers: headers(workspaceId) });
    if (!res.ok) throw new Error(`job ${j.jobId}: ${res.status}`);
    j = (await res.json()) as Job;
    onProgress?.(j);
  }
  return j;
}

/** Pull annotations a job committed into the Studio store (one undo step). */
async function mergeCommitted(store: HostStore, workspaceId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const res = await apiFetch(apiUrl(`/annotations/${encodeURIComponent(workspaceId)}`), { headers: headers(workspaceId) });
  if (!res.ok) return;
  const doc = (await res.json()) as { annotations: { id: string }[] };
  const want = new Set(ids);
  const fresh = doc.annotations.filter((a) => want.has(a.id));
  const s = store.getState();
  if (s.projectId === workspaceId && fresh.length) s.batch({ upsert: fresh as never });
}

/** Route gateway commands no local handler takes to the kernel. */
export function connectKernel(store: HostStore): void {
  if (!kernelEnabled()) return;
  setGatewayTransport(async (command, input, ctx): Promise<GatewayResult> => {
    const workspaceId = store.getState().projectId;
    if (!workspaceId) return { ok: false, error: "no project is open" };
    const body = { tool: command, input: { ...input, ...(ctx.assetIds?.[0] && !("asset_id" in input) ? { asset_id: ctx.assetIds[0] } : {}), ...(ctx.itemId && !("item_id" in input) ? { item_id: ctx.itemId } : {}) } };
    const res = await apiFetch(apiUrl("/v1/commands"), { method: "POST", headers: { ...headers(workspaceId), "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body) });
    const out = (await res.json().catch(() => ({}))) as { job?: Job; detail?: unknown };
    if (!res.ok && res.status !== 202) return { ok: false, status: res.status, error: typeof out.detail === "string" ? out.detail : JSON.stringify(out.detail ?? out) };
    const done = out.job ? await waitForJob(workspaceId, out.job, (j) => store.getState().setViewerStatus(`${command}: ${Math.round(j.progress * 100)}%`)) : undefined;
    if (done?.state !== "succeeded") return { ok: false, error: done?.error ?? `job ${done?.state}` };
    await mergeCommitted(store, workspaceId, done.result?.annotationIds ?? []);
    return { ok: true, via: "kernel", result: done.result };
  });
}
