import { MutationCache, QueryCache, useQuery, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { apiFetch, onUnauthorized } from "@/extension-host/http";
import { apiUrl, runtimeConfig } from "@/extension-host/runtime-config";
import { ACCOUNT, ORG } from "@/studio/lib/account-mock";

/**
 * Who is signed in (todo9 Phase 4): `GET /api/auth/session`, the API's view of the cookie
 * session. In `dev` mode (no sign-in), or in seed mode where there is no API, it's the mock
 * account with every permission, so the seed-mode e2e suite runs as before. In `workos` mode a
 * 401 anywhere (the session itself, or any API call later: the session expired mid-work) sends
 * the browser to `/api/auth/login?return_to=<where it was>`, after the Studio has kept its
 * unsaved annotations (`onBeforeSignIn`).
 */

export interface SessionUser {
  /** The principal, `user:<workos id>`. */
  id: string;
  workosUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
  avatarUrl: string | null;
}

export interface SessionOrg {
  /** Our organization id. */
  id: string;
  workosOrgId: string | null;
  name: string;
}

export interface Session {
  mode: "dev" | "workos";
  user: SessionUser;
  organization: SessionOrg;
  /** Role slug in the current organization. */
  role: string;
  permissions: string[];
  organizations: SessionOrg[];
  impersonator: { email: string; reason: string | null } | null;
  expiresAt: string | null;
}

/** Organization permissions (todo9 D5). The API enforces each one; the UI only hides or disables. */
export const PERMISSIONS = ["org:manage", "members:manage", "billing:manage", "apikeys:manage", "audit:read", "project:create"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const sessionKey = ["auth", "session"] as const;

/** The mock account (account-mock.ts) as a session: an admin of one personal organization. */
export function mockSession(): Session {
  const org: SessionOrg = { id: ORG.id, workosOrgId: null, name: ORG.name };
  return {
    mode: "dev",
    user: { id: `user:${ACCOUNT.id}`, workosUserId: ACCOUNT.id, email: ACCOUNT.email, firstName: ACCOUNT.firstName, lastName: ACCOUNT.lastName, name: ACCOUNT.name, avatarUrl: null },
    organization: org,
    role: "admin",
    permissions: [...PERMISSIONS],
    organizations: [org],
    impersonator: null,
    expiresAt: null,
  };
}

/** The API answered 401: nobody is signed in (the redirect to sign-in is already under way). */
export class SignedOutError extends Error {
  readonly status = 401;
  constructor() {
    super("Signed out");
  }
}

/** Any error that means "signed out": ours, or a 401 from an API call (`ApiError.status`). */
export const isUnauthorized = (e: unknown): boolean => !!e && typeof e === "object" && (e as { status?: unknown }).status === 401;

const isJson = (res: Response) => (res.headers.get("content-type") ?? "").includes("json");

export async function fetchSession(): Promise<Session> {
  const { auth, kernel } = runtimeConfig();
  const dev = auth.mode === "dev";
  // Seed mode: the Vite seed server has no /api/auth.
  if (dev && !kernel) return mockSession();
  let res: Response;
  try {
    res = await apiFetch(apiUrl("/auth/session"), { headers: { Accept: "application/json" } });
  } catch (e) {
    if (dev) return mockSession();
    throw e;
  }
  if (res.ok && isJson(res)) return (await res.json()) as Session;
  // Dev mode against an API that doesn't serve sessions yet (or at all): the mock account.
  if (dev) return mockSession();
  if (res.status === 401) throw new SignedOutError();
  throw new Error(`Couldn't load your session (${res.status} ${res.statusText})`);
}

export type Can = (permission: Permission | string) => boolean;
export const can = (session: Pick<Session, "permissions"> | undefined, permission: Permission | string): boolean => !!session?.permissions.includes(permission);

/** The session query. `data` is always there in `dev` mode; in `workos` mode `SessionGate` waits for it. */
export function useSessionQuery() {
  const dev = runtimeConfig().auth.mode === "dev";
  return useQuery({
    queryKey: sessionKey,
    queryFn: fetchSession,
    staleTime: 60_000,
    retry: (n, e) => !isUnauthorized(e) && n < 1,
    ...(dev ? { placeholderData: mockSession } : {}),
  });
}

/** The signed-in person, their current organization and permissions, plus `can(permission)`. */
export function useSession(): Session & { can: Can } {
  const { data } = useSessionQuery();
  // SessionGate renders nothing below it until a workos session has loaded.
  if (!data) throw new Error("useSession() before the session loaded (render under SessionGate)");
  return { ...data, can: (p) => can(data, p) };
}

/** `const can = useCan(); can("members:manage")`, for pages that only gate controls. */
export function useCan(): Can {
  return useSession().can;
}

// ---- Signing in again -------------------------------------------------------------------------

/** `/api/auth/login?return_to=<path+search>` (the API checks it's a same-origin path). */
export function loginUrl(returnTo: string = location.pathname + location.search): string {
  return apiUrl(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
}

/** True from the moment the browser is on its way to the sign-in page ("Signing you in…"). */
export const useSignIn = create<{ redirecting: boolean }>(() => ({ redirecting: false }));

const beforeSignIn = new Set<() => void>();

/** Run `fn` just before a sign-in redirect leaves the page (the Studio keeps unsaved annotations). */
export function onBeforeSignIn(fn: () => void): () => void {
  beforeSignIn.add(fn);
  return () => void beforeSignIn.delete(fn);
}

/** Full-page navigation (an object so tests can replace it; jsdom's `location.assign` is fixed). */
export const browser = { assign: (url: string) => window.location.assign(url) };

/** Leave for the sign-in page and come back here. Only in `workos` mode, and only once. */
export function signInAgain(navigate: (url: string) => void = (url) => browser.assign(url)): void {
  if (runtimeConfig().auth.mode !== "workos" || useSignIn.getState().redirecting) return;
  useSignIn.setState({ redirecting: true });
  for (const fn of beforeSignIn) {
    try {
      fn();
    } catch (e) {
      console.warn("[sign-in] before-redirect hook failed", e);
    }
  }
  navigate(loginUrl());
}

/** Query and mutation caches whose errors send a signed-out person to sign in (boot.tsx). */
export function sessionCaches(): { queryCache: QueryCache; mutationCache: MutationCache } {
  const onError = (e: unknown) => {
    if (isUnauthorized(e)) signInAgain();
  };
  return { queryCache: new QueryCache({ onError }), mutationCache: new MutationCache({ onError }) };
}

/** Wire the shared fetch's 401 hook to `signInAgain` (boot.tsx, once). */
export function installSessionHandlers(): () => void {
  return onUnauthorized(() => signInAgain());
}

// ---- Account actions ---------------------------------------------------------------------------

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(apiUrl(path), {
    method: "POST",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { detail?: unknown };
  if (!res.ok) throw Object.assign(new Error(typeof data.detail === "string" ? data.detail : `${res.status} ${res.statusText}`), { status: res.status });
  return data;
}

/** `POST /api/auth/logout` → the WorkOS logout URL to go to (the cookie is already cleared). */
export async function logout(): Promise<string> {
  const { url } = await post<{ url?: string }>("/auth/logout");
  return url || "/";
}

/**
 * `POST /api/auth/switch-org`. Either the session now names that organization (`{ok}`), or the
 * organization needs its own sign-in (SSO, MFA) and the browser must go to `redirect` first.
 */
export async function switchOrg(organizationId: string): Promise<{ redirect?: string }> {
  const r = await post<{ ok?: boolean; redirect?: string }>("/auth/switch-org", { organizationId });
  return r.redirect ? { redirect: r.redirect } : {};
}

/**
 * After an organization switch nothing cached belongs to the new organization: load the new
 * session first (so everything under SessionGate keeps a session), then drop every other query.
 */
export async function resetForOrg(client: QueryClient): Promise<void> {
  await client.fetchQuery({ queryKey: sessionKey, queryFn: fetchSession, staleTime: 0 });
  client.removeQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] });
}
