/**
 * todo18 D2: the one error decoder for the web. Every failed call to our services becomes an
 * `ApiProblem` (problem JSON from todo17 D6, the older `{errors: […]}` and `{detail}` shapes, or a
 * network failure), and UI states are chosen from it, never from the raw message.
 */

export interface ProblemViolation {
  /** Rule or field code (`label.unknown`, `name.invalid`, …). */
  code?: string;
  /** JSON pointer or field path the violation is about. */
  path?: string;
  message: string;
  /** Suggested fixes, shown as buttons or hints. */
  fixes?: { label: string; value?: unknown }[];
}

export type ProblemKind = "session" | "forbidden" | "gone" | "conflict" | "invalid" | "rate-limited" | "server" | "offline" | "other";

export interface ApiProblem {
  status: number; // 0 when offline / the request never reached the server
  kind: ProblemKind;
  code?: string;
  title: string;
  detail?: string;
  violations: ProblemViolation[];
  retryable: boolean;
  /** Seconds to wait before retrying (Retry-After or the problem's own field). */
  retryAfter?: number;
  /** The server's copy of the resource on a 409, when it sends one. */
  current?: unknown;
  /** Trash batch that restores a 410 / trashed resource, when the server says. */
  trashBatchId?: string;
  requestId?: string;
  raw?: unknown;
}

/** An Error carrying its ApiProblem, so `throw` sites keep working with `catch (e)`. */
export class ProblemError extends Error {
  readonly problem: ApiProblem;
  constructor(problem: ApiProblem) {
    super(problem.detail || problem.title);
    this.name = "ProblemError";
    this.problem = problem;
  }
  get status() {
    return this.problem.status;
  }
}

export function kindOf(status: number): ProblemKind {
  if (status === 0) return "offline";
  if (status === 401) return "session";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "gone";
  if (status === 409 || status === 412) return "conflict";
  if (status === 400 || status === 413 || status === 422) return "invalid";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "other";
}

const TITLES: Record<ProblemKind, string> = {
  session: "Your session ended. Sign in again to continue.",
  forbidden: "You don't have permission to do that here.",
  gone: "This no longer exists.",
  conflict: "Someone else changed this at the same time.",
  invalid: "That couldn't be saved as it is.",
  "rate-limited": "Too many requests. Try again in a moment.",
  server: "Something went wrong on our side. Try again.",
  offline: "You're offline. Your changes are kept until you're back.",
  other: "That didn't work.",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function violationsFrom(body: Record<string, unknown>): ProblemViolation[] {
  const list = (body.violations ?? body.errors ?? (Array.isArray(body.detail) ? body.detail : undefined)) as unknown;
  if (!Array.isArray(list)) return [];
  return list.map((v): ProblemViolation => {
    if (typeof v === "string") return { message: v };
    const o = (v ?? {}) as Record<string, unknown>;
    const loc = Array.isArray(o.loc) ? o.loc.join(".") : undefined; // FastAPI validation errors
    return {
      code: str(o.code) ?? str(o.rule) ?? str(o.type),
      path: str(o.path) ?? str(o.pointer) ?? loc,
      message: str(o.message) ?? str(o.msg) ?? str(o.detail) ?? "Invalid value",
      fixes: Array.isArray(o.fixes) ? (o.fixes as ProblemViolation["fixes"]) : undefined,
    };
  });
}

/** Decode a response body (already parsed, or text) and status into an ApiProblem. */
export function problemFrom(status: number, body: unknown, headers?: Headers | null): ApiProblem {
  const kind = kindOf(status);
  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const detailField = typeof o.detail === "string" ? o.detail : o.detail && typeof o.detail === "object" && !Array.isArray(o.detail) ? str((o.detail as Record<string, unknown>).message) ?? str((o.detail as Record<string, unknown>).detail) : undefined;
  const ra = headers?.get("Retry-After");
  const retryAfter = typeof o.retryAfter === "number" ? o.retryAfter : ra && /^\d+$/.test(ra) ? Number(ra) : ra ? Math.max(0, Math.round((Date.parse(ra) - Date.now()) / 1000)) || undefined : undefined;
  const nested = o.detail && typeof o.detail === "object" && !Array.isArray(o.detail) ? (o.detail as Record<string, unknown>) : {};
  return {
    status,
    kind,
    code: str(o.code) ?? str(nested.code) ?? str(o.type)?.split("/").pop(),
    title: str(o.title) ?? TITLES[kind],
    detail: detailField ?? (typeof body === "string" && body.length < 500 ? body : undefined),
    violations: violationsFrom(o).length ? violationsFrom(o) : violationsFrom(nested),
    retryable: typeof o.retryable === "boolean" ? o.retryable : kind === "server" || kind === "offline" || kind === "rate-limited",
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
    current: o.current ?? nested.current,
    trashBatchId: str(o.trashBatchId) ?? str(nested.trashBatchId),
    requestId: str(o.requestId) ?? str(o.request_id) ?? headers?.get("X-Request-Id") ?? undefined,
    raw: body,
  };
}

/** Read a failed Response into an ApiProblem (never throws). */
export async function problemFromResponse(res: Response): Promise<ApiProblem> {
  let body: unknown = undefined;
  try {
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
  } catch {
    /* body already used or unreadable */
  }
  return problemFrom(res.status, body, res.headers);
}

/** Throw a ProblemError for a non-ok Response; return it otherwise. */
export async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) throw new ProblemError(await problemFromResponse(res));
  return res;
}

/** Any thrown value → ApiProblem: ProblemError, fetch's TypeError (offline), errors with a status, or plain text. */
export function toProblem(e: unknown): ApiProblem {
  if (e instanceof ProblemError) return e.problem;
  if (e && typeof e === "object" && "problem" in e && (e as { problem?: unknown }).problem && typeof (e as { problem: ApiProblem }).problem.status === "number") return (e as { problem: ApiProblem }).problem;
  if (e instanceof TypeError || (typeof navigator !== "undefined" && navigator.onLine === false)) return problemFrom(0, undefined);
  const status = e && typeof e === "object" && typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : undefined;
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : undefined;
  if (status !== undefined) return { ...problemFrom(status, (e as { body?: unknown }).body ?? message), detail: message };
  const m = message?.match(/^(\d{3})\b/); // legacy `${status} ${statusText}` errors
  if (m) return problemFrom(Number(m[1]), message);
  return { ...problemFrom(-1, undefined), kind: "other", detail: message, retryable: false };
}

/** One line for a toast or inline error: the detail when the server gave one, else the kind's title. */
export function problemMessage(e: unknown): string {
  const p = toProblem(e);
  const first = p.violations[0]?.message;
  if (p.kind === "invalid" && first) return p.violations.length > 1 ? `${first} (+${p.violations.length - 1} more)` : first;
  if (p.kind === "rate-limited" && p.retryAfter) return `Too many requests. Try again in ${p.retryAfter} s.`;
  return p.detail && p.kind !== "server" ? p.detail : p.title;
}
