import { RES } from "@studio/contracts/naming";
import { runtimeConfig } from "@/extension-host/runtime-config";

/**
 * Dev-only identity switch (todo14 Milestone 0): until sign-in exists (todo9), every browser is
 * the api's default dev principal (`user:local-expert`, who sees the samples). "Start as a new
 * person" in the account menu picks a random `user:dev-<id>` for this tab (sessionStorage), and
 * every request to the api or the agent carries it as `X-Dev-Principal`, which the api (and the
 * agent) honour in dev auth mode. "Back to local-expert" clears it.
 *
 * `fetch` gets the header from `installDevPrincipalFetch`; an `EventSource` can't set headers, so
 * its URL carries `devPrincipal=` and the Vite proxy turns that into the header (vite.config.ts).
 * In a production build, or with WorkOS sign-in (`auth.mode: workos`), none of this is active.
 */
export const DEV_PRINCIPAL_HEADER = "X-Dev-Principal";
export const DEV_PRINCIPAL_PARAM = "devPrincipal";
/** The api's default dev principal (apps/api config `dev_principal`); requests without the header act as it. */
export const DEFAULT_DEV_PRINCIPAL = "user:local-expert";
const KEY = `${RES}-dev-principal`;
const VALID = /^user:dev-[a-z0-9]{4,32}$/;

/** Only on the Vite dev server, and never with WorkOS sign-in (the api ignores the header there anyway). */
const isDev = () => (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true && runtimeConfig().auth?.mode !== "workos";

/** Whether the account menu offers "Start as a new person". */
export const devPrincipalAvailable = isDev;

/** The principal this tab acts as, when "Start as a new person" picked one (dev only). */
export function devPrincipal(): string | null {
  if (!isDev()) return null;
  try {
    const v = sessionStorage.getItem(KEY);
    return v && VALID.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Pick a fresh `user:dev-<id>` for this tab and return it; null when storage is blocked. */
export function startAsNewPerson(): string | null {
  const id = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/g, "").slice(0, 12);
  const principal = `user:dev-${id}`;
  try {
    sessionStorage.setItem(KEY, principal);
    return principal;
  } catch {
    return null;
  }
}

/** Back to the api's default dev principal. */
export function backToDefaultPrincipal(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: nothing was stored */
  }
}

/** Per-person storage keys live in person-key.ts (todo15 D1); re-exported for existing imports. */
export { personKey } from "@/studio/lib/person-key";

/** Our own api and agent: same-origin `/api/…` (the default bases), or the configured bases. */
function ours(url: URL, bases: string[]): boolean {
  return bases.some((b) => {
    const base = new URL(b, location.origin);
    return url.origin === base.origin && (url.pathname === base.pathname || url.pathname.startsWith(`${base.pathname.replace(/\/$/, "")}/`));
  });
}

/** `url` with `devPrincipal=` added, for transports that can't send headers (EventSource). */
export function withDevPrincipal(url: string): string {
  const p = devPrincipal();
  if (!p) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${DEV_PRINCIPAL_PARAM}=${encodeURIComponent(p)}`;
}

/** Wrap `window.fetch` so requests to the api and agent bases carry `X-Dev-Principal` (dev only, once). */
export function installDevPrincipalFetch(bases: () => string[]): void {
  if (!isDev() || typeof window === "undefined") return;
  const w = window as Window & { __devPrincipalFetch?: boolean };
  if (w.__devPrincipalFetch) return;
  w.__devPrincipalFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const p = devPrincipal();
    if (!p) return original(input, init);
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    } catch {
      return original(input, init);
    }
    if (!ours(url, bases())) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(DEV_PRINCIPAL_HEADER, p);
    return original(input, { ...init, headers });
  };
}
