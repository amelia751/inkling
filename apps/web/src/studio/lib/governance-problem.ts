import { ApiError, NeedsApiError } from "@/studio/lib/projects-api";

/**
 * todo17 governance screens (Changes, Health, Rules, Connected agents): field-level reading of
 * problem JSON. The app-wide decoder is ./problem.ts (todo18 D2); fold this into it later.
 *
 * Problem JSON for rejected writes (todo17 D6). The kernel answers a write that breaks the rules
 * with RFC 9457 `{ code: "write_rejected", violations: [...] }`; older validators answer
 * `{ detail: { error, issues: [{ path, message }] } }`. Screens get one shape: a title and a list of
 * violations keyed by a dotted field path (`labels.0.name`), so they can show each one by its field.
 */

export interface ProblemViolation {
  /** Dotted field path: `labels.0.name` (from the JSON pointer `/labels/0/name`). Empty for the whole input. */
  field: string;
  message: string;
  rule?: string;
  severity?: string;
  fix?: string;
}

export interface Problem {
  status: number;
  /** `write_rejected`, `forbidden`, `stale`, `needs-update` or whatever the body says. */
  code: string;
  title: string;
  violations: ProblemViolation[];
}

/** `/labels/0/name`, `labels/0/name`, `body.labels.0.name` → `labels.0.name`. */
export function fieldOf(path: unknown): string {
  if (typeof path !== "string") return Array.isArray(path) ? path.map(String).filter((s) => s !== "body").join(".") : "";
  const parts = path
    .split(/[/.]/)
    .filter(Boolean)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  return (parts[0] === "body" ? parts.slice(1) : parts).join(".");
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Read a parsed error body (or an `ApiError`) as a `Problem`; null when there's nothing to read. */
export function parseProblem(input: unknown, status = 0): Problem | null {
  if (input instanceof ApiError) return parseProblem(input.body, input.status) ?? { status: input.status, code: "", title: input.message, violations: [] };
  if (!input || typeof input !== "object") return null;
  const body = input as Record<string, unknown>;
  const st = typeof body.status === "number" ? body.status : status;
  if (Array.isArray(body.violations)) {
    return {
      status: st,
      code: str(body.code) ?? "write_rejected",
      title: str(body.title) ?? str(body.detail) ?? "The write was rejected",
      violations: body.violations.map((v) => {
        const o = (v ?? {}) as Record<string, unknown>;
        return { field: fieldOf(o.path), message: str(o.message) ?? str(o.rule) ?? "Not allowed", rule: str(o.rule), severity: str(o.severity), fix: str(o.fix) };
      }),
    };
  }
  const detail = body.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>;
    if (Array.isArray(d.violations)) return parseProblem({ ...d, status: st }, st);
    const issues = Array.isArray(d.issues) ? d.issues : [];
    return {
      status: st,
      code: str(d.code) ?? (st === 409 ? "stale" : ""),
      title: str(d.error) ?? str(d.message) ?? str(d.title) ?? `Request failed (${st})`,
      violations: issues.map((i) => {
        const o = (i ?? {}) as Record<string, unknown>;
        return { field: fieldOf(o.path ?? o.loc), message: str(o.message) ?? str(o.msg) ?? "Invalid" };
      }),
    };
  }
  // FastAPI's own 422: `{ detail: [{ loc, msg }] }`.
  if (Array.isArray(detail)) {
    return {
      status: st,
      code: "invalid",
      title: "Some fields aren't valid",
      violations: detail.map((i) => {
        const o = (i ?? {}) as Record<string, unknown>;
        return { field: fieldOf(o.loc ?? o.path), message: str(o.msg) ?? str(o.message) ?? "Invalid" };
      }),
    };
  }
  const title = str(detail) ?? str(body.error) ?? str(body.title) ?? str(body.message);
  return title ? { status: st, code: str(body.code) ?? "", title, violations: [] } : null;
}

/** The violations under one field (`labels.0` matches `labels.0.name` too, unless `exact`). */
export function violationsAt(problem: Problem | null | undefined, field: string, exact = false): ProblemViolation[] {
  if (!problem) return [];
  return problem.violations.filter((v) => v.field === field || (!exact && v.field.startsWith(`${field}.`)));
}

/** A one-line message for any error: the problem's title, else the error's message. */
export function problemText(e: unknown): string {
  if (e === null || e === undefined) return "Something went wrong";
  const p = parseProblem(e);
  if (p) return p.violations.length === 1 ? p.violations[0].message : p.title;
  return e instanceof Error ? e.message : String(e);
}

/** Whether the server doesn't have this route yet (backends land in parallel): 404, 405 or 501. */
export function isMissingRoute(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 404 || e.status === 405 || e.status === 501;
  return e instanceof NeedsApiError;
}
