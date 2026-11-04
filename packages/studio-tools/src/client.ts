import type { JsonPatchOp } from "./schemas.ts";

/**
 * HTTP client for the Studio routes of the API (todo11 §6 contracts): boots, environments and
 * tasks. Fetch-based and framework-neutral; the caller supplies the base URL, the bearer token and
 * any extra headers (the in-app agent adds `X-Workspace-Id` and `X-Agent-Run`).
 */

export interface StudioClientOptions {
  baseUrl: string;
  /** Bearer token per request (the agent's kernel token is refreshed with each message). */
  token?: () => string | undefined | Promise<string | undefined>;
  /** Extra headers per request. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** On a 401: get a fresh token (true when one was had); the request is retried once. */
  refresh?: () => Promise<boolean>;
  fetch?: typeof fetch;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

/** A non-2xx answer: the status, the API's message and its `errors[]` (422 / 403 scope), `current` on a 409. */
export class StudioApiError extends Error {
  override name = "StudioApiError";
  constructor(
    readonly status: number,
    message: string,
    readonly errors: ValidationIssue[] = [],
    /** On 409 (stale revision): the current revision, when the API sent it. */
    readonly current?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export type BootState = "running" | "ready" | "failed";

export interface BootRequest {
  bootId: string;
  preset: string;
  /** todo19 D4: one profile per accepted kind, deep-merged into `data.kinds`. */
  extends?: string[];
  /** todo19 D2: data kind ids the task takes. */
  accepts?: string[];
  filter?: { folders?: string[]; files?: string[]; nameContains?: string };
  patch?: JsonPatchOp[];
  files?: string[];
  folders?: string[];
  name?: string;
  intent?: string;
}

export interface BootAccepted {
  bootId: string;
  taskIds: string[];
  state: BootState;
  preset: string;
  ms?: number;
}

export interface BootStatus {
  bootId: string;
  projectId: string;
  taskIds: string[];
  preset: string;
  state: BootState;
  steps: { step: string; state: string; label: string }[];
  ms?: number;
  initiator?: { kind: "person" | "agent"; runId?: string };
}

export interface EnvironmentState {
  revision: number;
  environment: Record<string, unknown> | null;
  effective?: Record<string, unknown>;
  contentHash?: string;
  author?: string;
  authorKind?: string;
  savedAt?: string;
}

/** `POST /api/v1/projects/{id}/previews` (todo23 D8): an immutable environment booted as a preview. */
export interface PreviewRequest {
  environment: Record<string, unknown>;
  datasetId?: string;
  title?: string;
  pluginVersions?: Record<string, string>;
  verification?: Record<string, unknown>;
}

export interface PreviewInfo {
  id: string;
  projectId: string;
  taskId: string;
  status: "active" | "kept" | "discarded";
  expiresAt: string | null;
  pluginVersions: Record<string, string>;
  verification?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface TaskInfo {
  id: string;
  state?: "draft" | "published" | "preview";
  bootId?: string | null;
  [key: string]: unknown;
}

const enc = encodeURIComponent;

function issues(v: unknown): ValidationIssue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({ path: String(e.path ?? ""), code: String(e.code ?? "invalid"), message: String(e.message ?? e.msg ?? "") }));
}

/** The API answers either directly (`{ok:false, errors}`, `{error, current}`) or FastAPI-style under `detail`. */
export function toApiError(status: number, data: unknown): StudioApiError {
  const top = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const detail = top.detail;
  const body = (detail && typeof detail === "object" && !Array.isArray(detail) ? detail : top) as Record<string, unknown>;
  const errors = issues(body.errors ?? (Array.isArray(detail) ? detail : undefined));
  const message =
    typeof detail === "string"
      ? detail
      : typeof body.message === "string"
        ? body.message
        : typeof body.error === "string"
          ? body.error
          : errors[0]?.message || `API returned ${status}`;
  const current = typeof body.current === "number" ? body.current : typeof (body.current as { revision?: unknown })?.revision === "number" ? (body.current as { revision: number }).revision : undefined;
  return new StudioApiError(status, message, errors, current, data);
}

export class StudioClient {
  constructor(private readonly opts: StudioClientOptions) {}

  async request<T>(method: string, path: string, json?: unknown, signal?: AbortSignal): Promise<T> {
    try {
      return await this.once<T>(method, path, json, signal);
    } catch (err) {
      if (!(err instanceof StudioApiError) || err.status !== 401 || !this.opts.refresh) throw err;
      if (!(await this.opts.refresh().catch(() => false))) throw err;
      return this.once<T>(method, path, json, signal);
    }
  }

  private async once<T>(method: string, path: string, json?: unknown, signal?: AbortSignal): Promise<T> {
    const token = await this.opts.token?.();
    if (this.opts.token && !token) throw new StudioApiError(401, "No API access for this session. Ask the person to reopen the assistant panel (it passes a fresh token with each message).");
    const headers: Record<string, string> = { ...(await this.opts.headers?.()), Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const res = await (this.opts.fetch ?? fetch)(new URL(path, this.opts.baseUrl), { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal });
    const data: unknown = await res.json().catch(() => ({}));
    if (!res.ok) throw toApiError(res.status, data);
    return data as T;
  }

  /** `POST /api/v1/projects/{projectId}/boots`: idempotent on `bootId`; creates a draft task. */
  boot(projectId: string, body: BootRequest, signal?: AbortSignal): Promise<BootAccepted> {
    return this.request("POST", `/api/v1/projects/${enc(projectId)}/boots`, body, signal);
  }

  getBoot(bootId: string, signal?: AbortSignal): Promise<BootStatus> {
    return this.request("GET", `/api/v1/boots/${enc(bootId)}`, undefined, signal);
  }

  getEnvironment(taskId: string, signal?: AbortSignal): Promise<EnvironmentState> {
    return this.request("GET", `/api/environments/${enc(taskId)}`, undefined, signal);
  }

  /** `revision` is required; a stale one is a 409 whose error carries `current`. */
  patchEnvironment(taskId: string, patch: JsonPatchOp[], revision: number, signal?: AbortSignal): Promise<EnvironmentState> {
    return this.request("PATCH", `/api/environments/${enc(taskId)}`, { patch, revision }, signal);
  }

  /** Boots a preview only the person sees; it never replaces their current Studio. */
  bootPreview(projectId: string, body: PreviewRequest, signal?: AbortSignal): Promise<PreviewInfo> {
    return this.request("POST", `/api/v1/projects/${enc(projectId)}/previews`, body, signal);
  }

  getTask(taskId: string, signal?: AbortSignal): Promise<TaskInfo> {
    return this.request("GET", `/api/v1/tasks/${enc(taskId)}`, undefined, signal);
  }
}
