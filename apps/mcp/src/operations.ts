// todo16 D7 + todo17 D8/D9/D13: one MCP tool per operation in the catalogue (schemas/operations.json,
// emitted from packages/contracts/src/operations.ts by `pnpm emit:schemas`), called on the kernel API
// with the caller's token. Every tool carries readOnlyHint / destructiveHint / idempotentHint from its
// tier; writes take `dryRun`, always send an `Idempotency-Key` (one per call, reused on retry) and,
// for versioned resources, the revision they were based on. `project_context` comes first.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export type Tier = "read" | "write" | "trash" | "destroy";

export interface CatalogOperation {
  id: string;
  tool: string;
  tier: Tier;
  method: string;
  path: string;
  description: string;
  removes?: string;
  /** Versioned resource: where its current `revision` is read (default: see REVISIONED). */
  revision?: { get: string };
  input: { type?: string; properties?: Record<string, unknown>; required?: string[] };
}

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export const OPERATIONS: CatalogOperation[] = JSON.parse(readFileSync(new URL("../../../schemas/operations.json", import.meta.url), "utf8")).operations;

/** Token scope each tier needs (D12). */
export const SCOPE_BY_TIER: Record<Tier, string> = { read: "project:read", write: "project:write", trash: "project:trash", destroy: "project:destroy" };
export const SCOPES = ["project:read", "project:write", "project:trash", "project:destroy", "rules:propose"] as const;

/**
 * Updates to versioned resources that the API rejects without the revision they were based on
 * (D13): where the current revision is read when the caller doesn't pass one. Paths use the
 * operation's own placeholders. The catalogue's own `revision.get` wins when it declares one.
 */
export const REVISIONED: Record<string, string> = {
  "studio.patch": "/api/environments/{pid}",
  "rules.patch": "/projects/{pid}/rules",
  "rules.put": "/projects/{pid}/rules",
};

export const PROJECT_CONTEXT = "project_context";
export const contextUri = (projectId: string) => `studio://projects/${encodeURIComponent(projectId)}/context`;
export const CONTEXT_URI_TEMPLATE = "studio://projects/{projectId}/context";

export function hints(tier: Tier, method: string): NonNullable<ToolDef["annotations"]> {
  const read = tier === "read";
  return {
    readOnlyHint: read,
    destructiveHint: tier === "trash" || tier === "destroy",
    idempotentHint: read || method === "PUT" || method === "PATCH" || method === "DELETE",
    openWorldHint: false,
  };
}

const revisionPath = (op: CatalogOperation) => op.revision?.get ?? REVISIONED[op.id];

/** The project_context tool: always the first one listed (D9). */
export const projectContextTool: ToolDef = {
  name: PROJECT_CONTEXT,
  title: "Project context (call first)",
  description:
    "Call this before writing anything in a project: its rules (labels with synonyms, layout, required metadata), open findings by rule, what's published (changing it opens a change request), recent changes, and how to add data here. Also served as resource " +
    CONTEXT_URI_TEMPLATE +
    ".",
  inputSchema: { type: "object", properties: { projectId: { type: "string", description: "The project" } }, required: ["projectId"], additionalProperties: false },
  annotations: hints("read", "GET"),
};

export function operationTools(): ToolDef[] {
  return OPERATIONS.map((op) => {
    const props: Record<string, unknown> = { projectId: { type: "string", description: "The project to act in" }, ...(op.input.properties ?? {}) };
    const required = ["projectId", ...(op.input.required ?? [])];
    if (op.tier !== "read") props.dryRun = { type: "boolean", description: "Run every check and return the would-be change and findings without saving anything." };
    if (revisionPath(op) && !props.revision) props.revision = { type: "integer", description: "The revision you edited. Omitted: the current one is fetched; a stale one comes back as a conflict." };
    if (op.tier === "destroy") {
      props.confirm = { type: "boolean", description: "Must be true: this deletes forever and can't be undone. Ask the person first." };
      required.push("confirm");
    }
    const note = op.tier === "trash" ? " Goes to the Trash (restorable for 30 days)." : op.tier === "destroy" ? " Permanent; ask the person first and pass confirm: true." : "";
    return { name: op.tool, description: `${op.description}${note}`, inputSchema: { type: "object", properties: props, required, additionalProperties: false }, annotations: hints(op.tier, op.method) };
  });
}

export const operationByTool = (name: string) => OPERATIONS.find((o) => o.tool === name);

/** The scope a tool call needs, or undefined for tools outside the catalogue. */
export function requiredScope(name: string): string | undefined {
  if (name === PROJECT_CONTEXT) return SCOPE_BY_TIER.read;
  const op = operationByTool(name);
  return op ? SCOPE_BY_TIER[op.tier] : undefined;
}

/** Whether a call counts against the daily write quota (writes that aren't dry runs). */
export function isWriteCall(name: string, args: Record<string, unknown> | undefined, envWrites: ReadonlySet<string> = new Set()): boolean {
  if (args?.dryRun === true) return false;
  if (envWrites.has(name)) return true;
  const op = operationByTool(name);
  return !!op && op.tier !== "read";
}

const fill = (path: string, projectId: string, args: Record<string, unknown>) => {
  let out = path.replace("{pid}", encodeURIComponent(projectId));
  for (const m of path.matchAll(/\{(\w+)\}/g)) {
    if (m[1] === "pid") continue;
    out = out.replace(m[0], encodeURIComponent(String(args[m[1]!] ?? "")));
    delete args[m[1]!];
  }
  // Catalogue paths are relative to /api/v1, except the few already under /api.
  return out.startsWith("/api/") ? out : `/api/v1${out}`;
};

const FS_OPS: Record<string, string> = { "source.mkdir": "mkdir", "source.rename": "rename", "source.move": "move", "source.copy": "copy", "source.trash": "trash", "source.restore": "restore", "source.purge": "purge" };

export interface PlannedRequest {
  method: string;
  path: string;
  body?: unknown;
  /** Read the revision here first (when the caller gave none). */
  revisionFrom?: string;
}

/** The HTTP request for a call, or an error message. Mirrors `operationRequest` in the contracts package. */
export function planRequest(op: CatalogOperation, args: Record<string, unknown>): PlannedRequest | { error: string } {
  const { projectId, confirm, dryRun, revision, ...rest } = args;
  if (typeof projectId !== "string" || !projectId) return { error: "projectId is required" };
  if (op.tier === "destroy" && confirm !== true) return { error: `${op.id} deletes forever and can't be undone: ask the person, then call again with confirm: true` };
  let path = fill(op.path, projectId, rest);
  const qs = new URLSearchParams();
  let body: Record<string, unknown> | undefined;
  if (FS_OPS[op.id]) {
    body = { ops: [{ kind: FS_OPS[op.id], ...rest }] };
  } else if ((op.method === "GET" || op.method === "DELETE")) {
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) qs.set(k, String(v));
  } else {
    body = rest;
  }
  if (dryRun === true && op.tier !== "read") qs.set("dryRun", "true");
  const rp = revisionPath(op);
  let revisionFrom: string | undefined;
  if (rp) {
    if (typeof revision === "number" && Number.isInteger(revision)) body = { ...(body ?? {}), revision };
    else revisionFrom = fill(rp, projectId, { ...args });
  }
  const q = qs.toString();
  if (q) path += `${path.includes("?") ? "&" : "?"}${q}`;
  return { method: op.method, path, ...(body !== undefined ? { body } : {}), ...(revisionFrom ? { revisionFrom } : {}) };
}

// ---- Calling the API ---------------------------------------------------------------------------

export interface Caller {
  apiUrl: string;
  /** Bearer sent to the API: the remote caller's token, or the local API key / person token. */
  token: string | undefined;
  fetch?: typeof fetch;
  /** New idempotency key (tests pin it). */
  newKey?: () => string;
  /** Retries on network errors and 502/503/504, same key each time. */
  retries?: number;
  retryDelayMs?: number;
}

export interface ApiReply {
  ok: boolean;
  status: number;
  data: any;
}

const RETRYABLE = new Set([502, 503, 504]);

export async function apiCall(caller: Caller, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<ApiReply> {
  const f = caller.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (caller.token) headers.Authorization = `Bearer ${caller.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const tries = 1 + (caller.retries ?? 2);
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, (caller.retryDelayMs ?? 250) * i));
    try {
      const res = await f(`${caller.apiUrl}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        /* keep text */
      }
      if (RETRYABLE.has(res.status) && i < tries - 1) {
        last = data;
        continue;
      }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(`API unreachable at ${caller.apiUrl}`);
}

const text = (t: string, isError = false, structured?: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}), ...(structured ? { structuredContent: structured } : {}) });

interface Violation {
  rule?: string;
  severity?: string;
  path?: string;
  message?: string;
  fix?: string;
  allowed?: unknown[];
  value?: unknown;
}

/** A violation on one line, with its fix inline. */
export function violationLine(v: Violation): string {
  const where = v.path ? ` at ${v.path}` : "";
  const allowed = v.allowed?.length ? ` Allowed: ${v.allowed.map((a) => JSON.stringify(a)).join(", ")}.` : "";
  return `- [${v.severity ?? "error"}] ${v.rule ?? "rule"}${where}: ${v.message ?? ""}${v.fix ? ` Fix: ${v.fix}` : ""}${allowed}`;
}

const changeRequestOf = (status: number, data: any) => {
  if (status !== 202 || !data || typeof data !== "object") return undefined;
  if (data.changeRequest && typeof data.changeRequest === "object") return data.changeRequest;
  return typeof data.id === "string" && typeof data.state === "string" ? data : undefined;
};

/** Turn an API reply into a tool result: problems with every violation inline, 202 change requests in words. */
export function formatReply(r: ApiReply, opts: { dryRun?: boolean } = {}): ToolResult {
  const json = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
  const cr = changeRequestOf(r.status, r.data);
  if (cr) {
    const findings: Violation[] = Array.isArray(cr.findings) ? cr.findings : [];
    const lines = [
      `Opened change request ${cr.id}${cr.title ? ` "${cr.title}"` : ""} (state: ${cr.state}). This changes something published, so it goes through review in Changes; it merges when its checks pass and the project allows it, or a person merges it.`,
      ...(findings.length ? ["Checks:", ...findings.map(violationLine)] : []),
      "",
      json,
    ];
    return text(lines.join("\n"), false, { changeRequest: cr });
  }
  if (r.ok) {
    const findings: Violation[] = Array.isArray(r.data?.findings) ? r.data.findings : [];
    const head = opts.dryRun || r.data?.dryRun ? "Dry run: nothing was saved.\n" : "";
    const warn = findings.length ? `Findings (saved, but fix these):\n${findings.map(violationLine).join("\n")}\n\n` : "";
    return text(`${head}${warn}${json}`);
  }
  const violations: Violation[] = Array.isArray(r.data?.violations) ? r.data.violations : [];
  if (violations.length) {
    const title = r.data?.title ?? "Write rejected";
    const lines = [
      `Rejected (${r.status} ${r.data?.code ?? "write_rejected"}): ${title}. Nothing was saved. Fix every violation below and call again:`,
      ...violations.map(violationLine),
      "",
      json,
    ];
    return text(lines.join("\n"), true);
  }
  if (r.status === 409) return text(`Conflict (409): someone changed this since you read it, or the same Idempotency-Key is still running. Read it again, re-apply your change and retry.\n\n${json}`, true);
  if (r.status === 401) return text(`Unauthorized (401): the token was rejected or revoked. Sign in again.\n\n${json}`, true);
  if (r.status === 403) return text(`Forbidden (403): your role or token scopes don't allow this.\n\n${json}`, true);
  return text(`Failed (${r.status}).\n\n${json}`, true);
}

/** Run a catalogue tool or project_context. Undefined when `name` is neither. */
export async function callOperationTool(caller: Caller, name: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
  if (name === PROJECT_CONTEXT) {
    const pid = typeof args.projectId === "string" ? args.projectId : "";
    if (!pid) return text("projectId is required", true);
    return formatReply(await apiCall(caller, "GET", `/api/v1/projects/${encodeURIComponent(pid)}/context`));
  }
  const op = operationByTool(name);
  if (!op) return undefined;
  const plan = planRequest(op, args);
  if ("error" in plan) return text(plan.error, true);
  let body = plan.body;
  if (plan.revisionFrom) {
    const cur = await apiCall(caller, "GET", plan.revisionFrom);
    if (!cur.ok) return formatReply(cur);
    const rev = typeof cur.data?.revision === "number" ? cur.data.revision : 0;
    body = { ...((body as Record<string, unknown>) ?? {}), revision: rev };
  }
  const key = op.tier === "read" ? undefined : (caller.newKey ?? randomUUID)();
  const r = await apiCall(caller, plan.method, plan.path, body, key);
  return formatReply(r, { dryRun: args.dryRun === true });
}

/** `studio://projects/{id}/context` → the context JSON, or undefined for other URIs. */
export async function readContextResource(caller: Caller, uri: string): Promise<{ contents: { uri: string; mimeType: string; text: string }[] } | undefined> {
  const m = /^studio:\/\/projects\/([^/]+)\/context$/.exec(uri);
  if (!m) return undefined;
  const r = await apiCall(caller, "GET", `/api/v1/projects/${m[1]}/context`);
  if (!r.ok) throw new Error(`project context: ${r.status} ${typeof r.data === "string" ? r.data : JSON.stringify(r.data)}`);
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(r.data, null, 2) }] };
}
