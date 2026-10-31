/**
 * Project URLs (todo6 Phase 2.1). Project and task ids live in the path; safe selections (a
 * tab, a view mode) go in the query; file names and other patient-ish strings never do
 * (node ids instead: docs/ux.md §11).
 */
export type ProjectSection = "overview" | "files" | "sources" | "explore" | "datasets" | "studio" | "review" | "activity" | "settings";

export const homeUrl = () => "/";
export const projectsUrl = () => "/projects";
export const newProjectUrl = () => "/projects/new";
/** `"sources"` is the old name of `"files"` (todo7 D11) and gives the same URL. */
export const projectUrl = (projectId: string, section: ProjectSection = "overview") => `/projects/${encodeURIComponent(projectId)}/${section === "sources" ? "files" : section}`;
/** The project's drive (todo7 D11): `/projects/:p/files/:nodeId?`. The nav label stays "Data"; the root folder is "Files". */
export const filesUrl = (projectId: string, nodeId?: string | null, query?: Record<string, string | undefined>) => withQuery(`${projectUrl(projectId, "files")}${nodeId ? `/${encodeURIComponent(nodeId)}` : ""}`, query);
/** The Trash view (todo7 Phase 4). */
export const trashUrl = (projectId: string) => `${projectUrl(projectId, "files")}/trash`;
/** Kept for existing callers: an alias of `filesUrl` (`/sources/*` redirects there too). */
export const sourcesUrl = filesUrl;
export const exploreUrl = (projectId: string, tab?: string, proposalId?: string) => withQuery(`${projectUrl(projectId, "explore")}${tab ? `/${tab}` : ""}`, { proposal: proposalId });
export const datasetUrl = (projectId: string, datasetId: string, tab?: "tasks" | "versions" | "publish") => `${projectUrl(projectId, "datasets")}/${encodeURIComponent(datasetId)}${tab && tab !== "tasks" ? `/${tab}` : ""}`;
export const versionReviewUrl = (projectId: string, datasetId: string, reviewId: string) => `${datasetUrl(projectId, datasetId, "versions")}/reviews/${encodeURIComponent(reviewId)}`;
export const studioUrl = (projectId: string, taskId?: string) => `${projectUrl(projectId, "studio")}${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
/** todo8 D7: the Task setup page (owners edit, annotators read). */
export const taskSetupUrl = (projectId: string, taskId: string) => `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/setup`;
export const settingsUrl = (projectId: string, tab: "general" | "plugins" | "members" = "general") => `${projectUrl(projectId, "settings")}/${tab}`;

function withQuery(path: string, query?: Record<string, string | undefined>): string {
  const q = Object.entries(query ?? {}).filter((e): e is [string, string] => !!e[1]);
  return q.length ? `${path}?${new URLSearchParams(q).toString()}` : path;
}

/** Where an attention row, an activity entry or an assistant link resolves (`ProjectTarget`). */
export function targetUrl(projectId: string, t: { section: string; nodeId?: string; importId?: string; proposalId?: string; tab?: string; taskId?: string; datasetId?: string; status?: string; reviewId?: string }): string {
  switch (t.section) {
    case "sources":
    case "files":
      if (t.tab === "trash") return trashUrl(projectId);
      return filesUrl(projectId, t.nodeId, { import: t.importId, status: t.status });
    case "explore":
      return exploreUrl(projectId, t.tab, t.proposalId);
    case "datasets":
      if (t.datasetId && t.reviewId) return versionReviewUrl(projectId, t.datasetId, t.reviewId);
      return t.datasetId ? datasetUrl(projectId, t.datasetId, t.tab === "versions" || t.tab === "publish" ? t.tab : undefined) : projectUrl(projectId, "datasets");
    case "settings":
      return settingsUrl(projectId, t.tab === "plugins" || t.tab === "members" ? t.tab : "general");
    case "studio":
      return studioUrl(projectId, t.taskId);
    case "review":
    case "activity":
    case "overview":
      return projectUrl(projectId, t.section);
    default:
      return projectUrl(projectId);
  }
}

/** Where an old `/projects/:p/sources/*` URL goes now (todo7 D11): the same node and query under `files`. */
export function filesRedirect(pathname: string, search = ""): string {
  return pathname.replace(/^(\/projects\/[^/]+)\/sources(?=\/|$)/, "$1/files") + search;
}
