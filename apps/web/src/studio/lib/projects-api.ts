import { useQuery } from "@tanstack/react-query";
import type {
  ActivityEntry,
  AttentionItem,
  ChildrenPage,
  DatasetSummary,
  ImportSession,
  ProjectOverview,
  ProjectSummary,
  Proposal,
  ResumeState,
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
