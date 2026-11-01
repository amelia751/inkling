import type { Annotation, AnnotationDocument } from "@studio/contracts/types";
import type { EnvironmentSpec } from "@studio/contracts/environment";
import type { PluginsLock } from "@studio/contracts/lockfile";
import { kernelEnabled } from "@/extension-host/kernel";
import { apiUrl } from "@/extension-host/runtime-config";

/**
 * The kernel's dataset-versioning routes (apps/api `routes/versioning.py`, todo4 Phase 6).
 * The browser never talks to apps/versioning; problems come back as problem+json with a
 * stable `code` (`stale_head`, `self_approval`, `not_ready`, `protected_branch`…).
 */

export interface Problem {
  status: number;
  code: string;
  title?: string;
  detail?: string;
  current_head?: string;
  problems?: string[];
}

export class VersioningError extends Error {
  constructor(public readonly problem: Problem) {
    super(problem.detail || problem.title || problem.code);
  }
  get code() {
    return this.problem.code;
  }
  get status() {
    return this.problem.status;
  }
}

export interface Branch {
  name: string;
  commit_oid: string;
  generation: number;
  protected: boolean;
  updated_at: string;
  created?: boolean;
}

export interface Commit {
  oid: string;
  parents: string[];
  author_id: string;
  on_behalf_of?: string;
  message: string;
  operation: "init" | "commit" | "merge" | "revert";
  created_at: string;
  sample_count?: number;
  annotation_count?: number;
  /** Git tree id of the commit's `.studio/` (todo10 §3.2). */
  studio_tree?: string;
}

export interface CommitResult {
  commit_oid: string;
  branch: string;
  head_generation: number;
  manifest_root: string;
}

export interface DiffChange {
  type: string;
  sample_id?: string;
  annotation_id?: string;
  class_id?: string;
  kind?: string;
  fields?: string[];
  base_ref?: string;
  head_ref?: string;
  base_annotation?: Annotation;
  head_annotation?: Annotation;
}

export interface DiffPage {
  base: string;
  head: string;
  summary: Record<string, number>;
  changes: DiffChange[];
  next_cursor?: string;
}

export type ReviewStatus = "DRAFT" | "OPEN" | "CHECKING" | "READY" | "BLOCKED" | "CONFLICTED" | "MERGING" | "MERGED" | "CLOSED";

export interface Conflict {
  conflict_key: string;
  kind: string;
  sample_id?: string;
  annotation_id?: string;
  field?: string;
  base_ref?: string;
  ours_ref?: string;
  theirs_ref?: string;
  resolution?: { choice: "ours" | "theirs" | "custom" } & Record<string, unknown>;
  ours_annotation?: Annotation;
  theirs_annotation?: Annotation;
  base_annotation?: Annotation;
}

export interface Review {
  id: string;
  title: string;
  description?: string;
  author_id: string;
  author_on_behalf_of?: string;
  source_branch: string;
  source_oid: string;
  target_branch: string;
  checked_target_oid?: string;
  base_oid?: string;
  status: ReviewStatus;
  required_approvals: number;
  merge_oid?: string;
  created_at: string;
  updated_at: string;
  approvals: { reviewer_id: string; approved_source_oid: string; created_at: string }[];
  checks: { name: string; mandatory: boolean; outcome: "pending" | "passed" | "failed" | "error"; details?: Record<string, unknown> }[];
  conflicts: Conflict[];
}

export interface Release {
  tag: string;
  commit_oid: string;
  manifest_root: string;
  created_by: string;
  created_at: string;
  retention_policy: string;
  /** The Studio setup the release pins (todo10 Phase 2). */
  studio_tree?: string;
  studio?: StudioSummary;
  studioWarning?: string;
}

/** What a `.studio/` tree pins, in hashes. */
export interface StudioSummary {
  tree?: string;
  lockfileHash?: string;
  tasks: Record<string, string>;
  fingerprint: string;
}

export interface StudioTask {
  environment?: EnvironmentSpec | null;
  contentHash?: string;
  readme?: string;
}

/** The Studio setup (lockfile, environments, READMEs) at a ref; `current` is the live one. */
export interface StudioSetup {
  commitOid: string;
  studioTree?: string;
  lockfile: PluginsLock | null;
  lockfileHash?: string;
  tasks: Record<string, StudioTask>;
  summary: StudioSummary;
  current?: { lockfile: PluginsLock | null; lockfileHash?: string; tasks: Record<string, StudioTask>; summary: StudioSummary };
}

export interface Resolution {
  conflict_key: string;
  choice: "ours" | "theirs" | "custom";
  /** For `custom`: the Studio annotation to use instead (the kernel uploads its revision). */
  annotation?: Annotation;
}

export interface VersionedDocument extends AnnotationDocument {
  head: string;
  branch: string | null;
}

const headers = (workspaceId: string) => ({ "Content-Type": "application/json", "X-Workspace-Id": workspaceId });

async function call<T>(workspaceId: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(`/v1${path}`), { method, headers: headers(workspaceId), body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const p = data as Partial<Problem>;
    throw new VersioningError({ status: res.status, code: p.code ?? "internal", title: p.title, detail: p.detail ?? (typeof (data as { detail?: unknown }).detail === "string" ? (data as { detail: string }).detail : res.statusText), current_head: p.current_head, problems: p.problems });
  }
  return data as T;
}

const ds = (id: string) => `/datasets/${encodeURIComponent(id)}`;

export interface VersioningStatus {
  configured: boolean;
  ready: boolean;
  principal?: string;
}

/** Off unless the kernel is on and reports the versioning service configured. */
export async function fetchStatus(workspaceId: string): Promise<VersioningStatus> {
  if (!kernelEnabled()) return { configured: false, ready: false };
  try {
    return await call<VersioningStatus>(workspaceId, "GET", "/versioning/status");
  } catch {
    return { configured: false, ready: false };
  }
}

export const api = {
  ensureDataset: (w: string, id: string) => call<{ datasetId: string; created: boolean; workBranch?: string }>(w, "POST", "/datasets", { id, import_document: true }),
  branches: (w: string, id: string) => call<{ items: Branch[]; workBranch: string }>(w, "GET", `${ds(id)}/branches`),
  ensureWorkBranch: (w: string, id: string) => call<Branch>(w, "POST", `${ds(id)}/branches`, {}),
  createBranch: (w: string, id: string, name: string, from = "main") => call<Branch>(w, "POST", `${ds(id)}/branches`, { name, from }),
  document: (w: string, id: string, ref: string) => call<VersionedDocument>(w, "GET", `${ds(id)}/document?ref=${encodeURIComponent(ref)}`),
  commit: (w: string, id: string, body: { branch: string; expected_head: string; message: string; document: { annotations: Annotation[] }; idempotency_key?: string }) =>
    call<CommitResult>(w, "POST", `${ds(id)}/commits`, body),
  commits: (w: string, id: string, ref: string) => call<{ items: Commit[] }>(w, "GET", `${ds(id)}/commits?ref=${encodeURIComponent(ref)}&limit=100`),
  revert: (w: string, id: string, body: { branch: string; expected_head: string; target_oid: string }) => call<CommitResult>(w, "POST", `${ds(id)}/reverts`, body),
  diff: (w: string, id: string, base: string, head: string) => call<DiffPage>(w, "GET", `${ds(id)}/diff?base=${encodeURIComponent(base)}&head=${encodeURIComponent(head)}&limit=1000`),
  openReview: (w: string, id: string, body: { title: string; source_branch: string; target_branch?: string; description?: string }) => call<Review>(w, "POST", `${ds(id)}/reviews`, body),
  reviews: (w: string, id: string) => call<{ items: Review[] }>(w, "GET", `${ds(id)}/reviews`),
  review: (w: string, id: string, rid: string) => call<Review>(w, "GET", `${ds(id)}/reviews/${rid}`),
  approve: (w: string, id: string, rid: string, source_oid: string) => call<Review>(w, "POST", `${ds(id)}/reviews/${rid}/approve`, { source_oid }),
  resolve: (w: string, id: string, rid: string, source_oid: string, target_oid: string | undefined, resolutions: Resolution[]) =>
    call<Review>(w, "POST", `${ds(id)}/reviews/${rid}/resolutions`, { source_oid, target_oid, resolutions }),
  merge: (w: string, id: string, rid: string) => call<Review>(w, "POST", `${ds(id)}/reviews/${rid}/merge`, {}),
  releases: (w: string, id: string) => call<{ items: Release[] }>(w, "GET", `${ds(id)}/releases`),
  release: (w: string, id: string, tag: string, ref: string) => call<Release>(w, "POST", `${ds(id)}/releases`, { tag, ref }),
  studio: (w: string, id: string, ref: string, current = false) => call<StudioSetup>(w, "GET", `${ds(id)}/studio?ref=${encodeURIComponent(ref)}${current ? "&current=true" : ""}`),
  commitStudio: (w: string, id: string, reason: string) => call<(CommitResult & { studio: StudioSummary }) | { unchanged: true; branch: string }>(w, "POST", `${ds(id)}/studio/commits`, { reason }),
};
