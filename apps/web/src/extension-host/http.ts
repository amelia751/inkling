/**
 * The one `fetch` for our own services (the kernel API under `apiBase`, the agent proxy under
 * `agentBase`). It sends the session cookie (`credentials: "same-origin"`) and the CSRF header
 * the API asks of every cookie-authenticated request that changes state (`X-Requested-With:
 * fetch`, todo9 Phase 3), and reports a 401 to the shell, which sends the browser to sign in
 * again (`studio/lib/session.ts`) when the person signed in with WorkOS.
 */

type UnauthorizedHandler = (res: Response) => void;
let unauthorized: UnauthorizedHandler | null = null;

/** The shell's reaction to a 401 (one handler; the last one set wins). Returns the unset function. */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
  unauthorized = handler;
  return () => {
    if (unauthorized === handler) unauthorized = null;
  };
}

/** `fetch` with the cookie, the CSRF header and the 401 hook. Headers the caller sets win. */
export async function apiFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("X-Requested-With")) headers.set("X-Requested-With", "fetch");
  const res = await fetch(input, { credentials: "same-origin", ...init, headers });
  if (res.status === 401) unauthorized?.(res);
  return res;
}
