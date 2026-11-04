/**
 * The scout's only way out to the internet: public metadata APIs (registries, deps.dev, OSV,
 * Scorecard). Injectable, so tests run offline with a fake.
 */
export type Fetcher = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const SCOUT_USER_AGENT = "studio-oss-scout/1 (metadata only)";

export class FetchError extends Error {
  override name = "FetchError";
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`${url} answered ${status}`);
  }
}

/** JSON from `url`; `undefined` on 404 (absent evidence is evidence), throws on other failures. */
export async function getJson<T>(fetcher: Fetcher, url: string, init: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T | undefined> {
  const signal = init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 15_000);
  const r = await fetcher(url, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { Accept: "application/json", "User-Agent": SCOUT_USER_AGENT, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal,
  });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new FetchError(url, r.status);
  return (await r.json()) as T;
}

export const defaultFetcher: Fetcher = (url, init) => fetch(url, init);

/** Run `fn` over `items` with at most `n` in flight. */
export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}
