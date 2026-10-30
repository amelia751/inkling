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

/**
 * The project API (apps/api routes/projects.py, sources.py, explore.py; the dev seed server's
 * read-only stand-in without the kernel, todo6 D4). Writes the stand-in can't do answer 501,
 * which surfaces as `NeedsApiError` so the UI can say "Adding data needs the full stack".
 */
export class NeedsApiError extends Error {
  constructor() {
    super("Adding data needs the full stack: see docs/running.md");
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(apiUrl(`/v1${path}`), {
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 501) throw new NeedsApiError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: unknown; error?: unknown };
    const msg = typeof body.detail === "string" ? body.detail : typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg);
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
export const searchNodes = (projectId: string, q: string, kind?: string, status?: string) =>
  api<{ items: SourceNode[] }>(`/projects/${encodeURIComponent(projectId)}/search?${new URLSearchParams({ q, ...(kind ? { kind } : {}), ...(status ? { status } : {}) })}`).then((r) => r.items);
export const fetchDatasets = (id: string) => api<{ datasets: DatasetSummary[] }>(`/projects/${encodeURIComponent(id)}/datasets`).then((r) => r.datasets);
export const fetchReview = (id: string) => api<{ items: AttentionItem[] }>(`/projects/${encodeURIComponent(id)}/review`).then((r) => r.items);
export const fetchProposals = (id: string, status?: string) => api<{ proposals: Proposal[] }>(`/projects/${encodeURIComponent(id)}/proposals${status ? `?status=${status}` : ""}`).then((r) => r.proposals);
export const fetchImports = (id: string) => api<{ imports: ImportSession[] }>(`/projects/${encodeURIComponent(id)}/imports`).then((r) => r.imports);
export const fetchActivity = (id: string, cursor?: string | null) => api<{ entries: ActivityEntry[]; nextCursor: string | null }>(`/projects/${encodeURIComponent(id)}/activity${cursor ? `?cursor=${cursor}` : ""}`);
export const fetchTask = (id: string) => api<TaskSummary>(`/tasks/${encodeURIComponent(id)}`);
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
export const patchProject = (id: string, body: Partial<Pick<ProjectSummary, "title" | "description" | "visibility" | "archived">>) =>
  api<ProjectSummary>(`/projects/${encodeURIComponent(id)}`, { method: "PATCH", json: body });

export function useReviewQueue(id: string, f: ReviewFilters = {}) {
  return useQuery({ queryKey: [...projectKeys.review(id), f.type ?? "", f.severity ?? "", f.dataset ?? ""], queryFn: () => fetchReviewQueue(id, f), staleTime: 5_000, placeholderData: (prev) => prev });
}

export function useDatasets(id: string) {
  return useQuery({ queryKey: projectKeys.datasets(id), queryFn: () => fetchDatasets(id), staleTime: 5_000 });
}

export function useDataset(projectId: string, datasetId: string) {
  return useQuery({ queryKey: [...projectKeys.datasets(projectId), datasetId], queryFn: () => fetchDataset(projectId, datasetId), staleTime: 5_000 });
}

/** One project by id, archived ones included (the list hides those). */
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
