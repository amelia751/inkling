import { problemFrom, type ApiProblem } from "./problem";
import { violationsText, type FindingLike } from "./findings";
import { useQuery } from "@tanstack/react-query";
import type {
  ActivityEntry,
  AttentionItem,
  ChildrenPage,
  DatasetSummary,
  ExploreSummary,
  ImportSession,
  ProjectOverview,
  ProjectSummary,
  Proposal,
  ProposalPreview,
  ResumeState,
  ReviewQueue,
  SourceNode,
  SourceNodeDetail,
  SourceSummary,
  TaskSummary,
} from "@studio/contracts/types";
import { apiUrl } from "@/extension-host/runtime-config";
import { apiFetch } from "@/extension-host/http";

/**
 * The project API (apps/api routes/projects.py, sources.py, explore.py; the dev seed server's
 * read-only stand-in without the kernel, todo6 D4). Writes the stand-in can't do answer 501,
 * which surfaces as `NeedsApiError` so the UI can say "Adding data needs the full stack".
 */
export class NeedsApiError extends Error {
  constructor() {
    super("Adding data needs the full stack: see README.md");
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed JSON error body (`{ detail }`), for callers that need more than the sentence (todo7 409 conflicts). */
    readonly body?: unknown,
    /** The API's `X-Request-Id`, shown in "Copy error details" so a report can be traced. */
    readonly requestId?: string,
    headers?: Headers | null,
  ) {
    super(message);
    // todo18 D2: the decoded problem, so `toProblem(e)` / UI states work on every `api()` failure.
    this.problem = problemFrom(status, body, headers);
    if (requestId && !this.problem.requestId) this.problem.requestId = requestId;
    if (!this.problem.detail && message) this.problem.detail = message;
  }
  readonly problem: ApiProblem;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await apiFetch(apiUrl(`/v1${path}`), {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 501) throw new NeedsApiError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown; error?: unknown; title?: unknown; violations?: unknown };
    const detailMessage = body.detail && typeof body.detail === "object" && typeof (body.detail as { message?: unknown }).message === "string" ? (body.detail as { message: string }).message : undefined;
    // todo17 D6: a rejected write is problem JSON listing every violation with its fix.
    // todo20 D8: grouped by rule, so 35 files breaking one rule read as one sentence with a count.
    const violations = Array.isArray(body.violations) ? (body.violations as FindingLike[]) : [];
    const problemMessage = violations.length ? violationsText(violations) : typeof body.title === "string" ? body.title : undefined;
    const msg = typeof body.detail === "string" ? body.detail : detailMessage ?? problemMessage ?? (typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`);
    // A 429's `Retry-After` (seconds) rides in the body, so `toProblem(e).retryAfter` sees it (todo18).
    const ra = res.headers.get("Retry-After");
    const withRetry = ra && /^\d+$/.test(ra) && body && typeof body === "object" && !("retryAfter" in body) ? { ...body, retryAfter: Number(ra) } : body;
    throw new ApiError(res.status, msg, withRetry, res.headers.get("X-Request-Id") ?? undefined, res.headers);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// ---- Queries -------------------------------------------------------------------------------------

export const projectKeys = {
  all: ["projects"] as const,
  list: (q?: string, sort?: string) => ["projects", "list", q ?? "", sort ?? "recent"] as const,
  one: (id: string) => ["projects", id] as const,
  overview: (id: string) => ["projects", id, "overview"] as const,
  sources: (id: string) => ["projects", id, "sources"] as const,
  children: (sourceId: string, node: string | null) => ["sources", sourceId, "children", node ?? ""] as const,
  node: (id: string) => ["source-nodes", id] as const,
  datasets: (id: string) => ["projects", id, "datasets"] as const,
  review: (id: string) => ["projects", id, "review"] as const,
  proposals: (id: string) => ["projects", id, "proposals"] as const,
  imports: (id: string) => ["projects", id, "imports"] as const,
  activity: (id: string) => ["projects", id, "activity"] as const,
  task: (id: string) => ["tasks", id] as const,
};

export const fetchProjectList = (q?: string, sort?: string) => api<{ projects: ProjectSummary[] }>(`/projects?${new URLSearchParams({ ...(q ? { q } : {}), ...(sort ? { sort } : {}) })}`).then((r) => r.projects);
export const fetchProject = (id: string) => api<ProjectSummary>(`/projects/${encodeURIComponent(id)}`);
export const fetchOverview = (id: string) => api<ProjectOverview>(`/projects/${encodeURIComponent(id)}/overview`);
export const fetchSources = (id: string) => api<{ sources: SourceSummary[] }>(`/projects/${encodeURIComponent(id)}/sources`).then((r) => r.sources);
export const fetchChildren = (sourceId: string, node: string | null, cursor?: string | null) =>
  api<ChildrenPage>(`/sources/${encodeURIComponent(sourceId)}/children?${new URLSearchParams({ ...(node ? { node } : {}), ...(cursor ? { cursor } : {}) })}`);
export const fetchNode = (id: string) => api<SourceNodeDetail>(`/source-nodes/${encodeURIComponent(id)}`);
export const fetchPreview = (id: string) => api<NodePreview>(`/source-nodes/${encodeURIComponent(id)}/preview`);
/** Search, with how many more matches are in Trash (`trashedMatches`, 0 when the api doesn't say). */
export const searchNodesWithTrash = (projectId: string, q: string, kind?: string, status?: string) =>
  api<{ items: SourceNode[]; trashedMatches?: number }>(`/projects/${encodeURIComponent(projectId)}/search?${new URLSearchParams({ q, ...(kind ? { kind } : {}), ...(status ? { status } : {}) })}`).then((r) => ({ items: r.items, trashedMatches: r.trashedMatches ?? 0 }));
export const searchNodes = (projectId: string, q: string, kind?: string, status?: string) =>
  api<{ items: SourceNode[] }>(`/projects/${encodeURIComponent(projectId)}/search?${new URLSearchParams({ q, ...(kind ? { kind } : {}), ...(status ? { status } : {}) })}`).then((r) => r.items);
export const fetchDatasets = (id: string) => api<{ datasets: DatasetSummary[] }>(`/projects/${encodeURIComponent(id)}/datasets`).then((r) => r.datasets);
export const fetchReview = (id: string) => api<{ items: AttentionItem[] }>(`/projects/${encodeURIComponent(id)}/review`).then((r) => r.items);
export const fetchProposals = (id: string, status?: string) => api<{ proposals: Proposal[] }>(`/projects/${encodeURIComponent(id)}/proposals${status ? `?status=${status}` : ""}`).then((r) => r.proposals);
export const fetchImports = (id: string) => api<{ imports: ImportSession[] }>(`/projects/${encodeURIComponent(id)}/imports`).then((r) => r.imports);
export const fetchActivity = (id: string, cursor?: string | null) => api<{ entries: ActivityEntry[]; nextCursor: string | null }>(`/projects/${encodeURIComponent(id)}/activity${cursor ? `?cursor=${cursor}` : ""}`);
/** todo16 D9: undo everything one assistant turn changed (newest first; 409 if changed since). */
export const undoTurn = (projectId: string, turnId: string) =>
  api<{ turnId: string; undone: number; batchIds: string[] }>(`/projects/${encodeURIComponent(projectId)}/turns/${encodeURIComponent(turnId)}/undo`, { method: "POST", json: {} });
export const fetchTask = (id: string) => api<TaskSummary>(`/tasks/${encodeURIComponent(id)}`);
/** A Studio even when it's in Trash with its dataset (`trashed`, `datasetTrashBatchId`), for the Studio page's empty state. */
export const fetchTaskIncludingTrashed = (id: string) => api<TaskSummary>(`/tasks/${encodeURIComponent(id)}?includeTrashed=true`);
export const putResume = (projectId: string, r: { taskId: string; itemId?: string | null; placement?: unknown; tool?: string | null }) =>
  api<{ resume: ResumeState | null }>(`/projects/${encodeURIComponent(projectId)}/resume`, { method: "PUT", json: r });

export interface NodePreview {
  nodeId: string;
  kind: string | null;
  url?: string;
  thumbnailUrl?: string;
  table?: { columns: { name: string; type: string; filled: number; total: number }[]; rows: string[][]; rowCount?: number; truncated?: boolean };
  dicom?: Record<string, unknown>;
  video?: Record<string, unknown>;
  facts: Record<string, unknown>;
}

export function useProjectList(q?: string, sort?: string) {
  return useQuery({ queryKey: projectKeys.list(q, sort), queryFn: () => fetchProjectList(q, sort), staleTime: 10_000 });
}

/** A sample template a person can copy into their organization (todo14 §4.3, `GET /v1/samples`). */
export interface SampleTemplate {
  id: string;
  title: string;
  modality: string;
  license: string;
  restricted: boolean;
}

/** A sample template itself (read-only, D7), as opposed to a person's editable copy of one (`sampleOf` set). */
export const isSampleTemplate = (p: Pick<ProjectSummary, "sample" | "sampleOf">) => p.sample && !p.sampleOf;

/** `POST /v1/projects/from-sample`: a private copy of the template in the caller's current organization (todo14 D2). */
export const copySample = (sampleId: string) => api<ProjectSummary>("/projects/from-sample", { method: "POST", json: { sampleId } });

/**
 * The sample templates, or `enabled: false` when the api doesn't offer them: turned off
 * (`API_SAMPLES_ENABLED`), an api without the route, or the seed stand-in (404), or any error.
 */
export function useSamples() {
  return useQuery({
    queryKey: ["samples"],
    queryFn: async (): Promise<{ enabled: boolean; samples: SampleTemplate[] }> => {
      try {
        const r = await api<{ enabled?: unknown; samples?: unknown }>("/samples");
        const samples = Array.isArray(r.samples) ? (r.samples as SampleTemplate[]) : [];
        return { enabled: r.enabled === true && samples.length > 0, samples };
      } catch {
        return { enabled: false, samples: [] };
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * A project's summary, read from the list the person can see: an id that isn't there (not a
 * member, or a manifest project injected by a test) is simply `undefined`, never a 404.
 */
export function useProjectSummary(id: string | undefined) {
  const list = useProjectList();
  return { ...list, data: id ? list.data?.find((p) => p.id === id) : undefined };
}

export function useOverview(id: string) {
  return useQuery({ queryKey: projectKeys.overview(id), queryFn: () => fetchOverview(id), staleTime: 5_000 });
}

// ---- Datasets, Review, Activity and Settings (todo6 Phase 8) --------------------------------------

export interface ReviewFilters {
  type?: string;
  severity?: string;
  dataset?: string;
}

export const fetchReviewQueue = (id: string, f: ReviewFilters = {}) =>
  api<ReviewQueue>(`/projects/${encodeURIComponent(id)}/review?${new URLSearchParams(Object.entries(f).filter((e): e is [string, string] => !!e[1]))}`);
export const fetchDataset = (projectId: string, datasetId: string) => api<DatasetSummary>(`/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}`);
export const createDataset = (projectId: string, body: { title: string; description?: string; nodeIds: string[]; task?: { title: string; preset?: string; kind?: string } }) =>
  api<DatasetSummary>(`/projects/${encodeURIComponent(projectId)}/datasets`, { method: "POST", json: body });
export const patchProject = (id: string, body: Partial<Pick<ProjectSummary, "title" | "description" | "visibility">>) =>
  api<ProjectSummary>(`/projects/${encodeURIComponent(id)}`, { method: "PATCH", json: body });

export function useReviewQueue(id: string, f: ReviewFilters = {}) {
  return useQuery({ queryKey: [...projectKeys.review(id), f.type ?? "", f.severity ?? "", f.dataset ?? ""], queryFn: () => fetchReviewQueue(id, f), staleTime: 5_000, placeholderData: (prev) => prev });
}

export function useDatasets(id: string, opts: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: projectKeys.datasets(id), queryFn: () => fetchDatasets(id), staleTime: 5_000, enabled: opts.enabled ?? true });
}

export function useDataset(projectId: string, datasetId: string) {
  return useQuery({ queryKey: [...projectKeys.datasets(projectId), datasetId], queryFn: () => fetchDataset(projectId, datasetId), staleTime: 5_000 });
}

/** One project by id. */
export function useProjectDetail(id: string) {
  return useQuery({ queryKey: projectKeys.one(id), queryFn: () => fetchProject(id), staleTime: 5_000 });
}

// ---- Explore (todo6 Phase 5) ---------------------------------------------------------------------

export const exploreKeys = {
  summary: (projectId: string) => ["projects", projectId, "explore"] as const,
  proposals: (projectId: string) => ["projects", projectId, "proposals", "all"] as const,
  preview: (proposalId: string) => ["proposals", proposalId, "preview"] as const,
};

export const fetchExplore = (projectId: string) => api<ExploreSummary>(`/projects/${encodeURIComponent(projectId)}/explore`);
export const fetchProposalPreview = (id: string) => api<ProposalPreview>(`/proposals/${encodeURIComponent(id)}/preview`);
/** A relationship with another column, target, ID rule or row fixes; a mapping with another column or renamed classes; a dataset's name. */
export const recomputeProposal = (id: string, body: Record<string, unknown>) => api<Proposal>(`/proposals/${encodeURIComponent(id)}/recompute`, { method: "POST", json: body });
export const confirmProposal = (id: string, payload?: Record<string, unknown>) =>
  api<{ proposal: Proposal; dataset?: DatasetSummary; task?: TaskSummary; importedLabels?: number }>(`/proposals/${encodeURIComponent(id)}/confirm`, { method: "POST", json: payload ? { payload } : {} });
export const dismissProposal = (id: string) => api<{ proposal: Proposal }>(`/proposals/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
