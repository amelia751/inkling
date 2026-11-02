/**
 * Project URLs (todo6 Phase 2.1). Project and task ids live in the path; safe selections (a
 * tab, a view mode) go in the query; file names and other patient-ish strings never do
 * (node ids instead: docs/ux.md §11).
 */
export type ProjectSection = "overview" | "files" | "sources" | "explore" | "datasets" | "studio" | "review" | "activity" | "settings";

export const homeUrl = () => "/";
export const projectsUrl = () => "/projects";
/** `"files"` is the old name of `"sources"` (todo7 D11, reverted) and gives the same URL. */
export const projectUrl = (projectId: string, section: ProjectSection = "overview") => `/projects/${encodeURIComponent(projectId)}/${section === "files" ? "sources" : section}`;
/** The project's drive: `/projects/:p/sources/:nodeId?`. The nav label and the root folder are both "Sources". */
export const filesUrl = (projectId: string, nodeId?: string | null, query?: Record<string, string | undefined>) => withQuery(`${projectUrl(projectId, "sources")}${nodeId ? `/${encodeURIComponent(nodeId)}` : ""}`, query);
/** The Trash view (todo7 Phase 4). */
export const trashUrl = (projectId: string) => `${projectUrl(projectId, "sources")}/trash`;
/** The project-wide Trash (todo16 M2): sources, datasets, collections and Studios. */
export const projectTrashUrl = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/trash`;
/** Change requests (todo17 M2): the list, or one change by id. */
export const changesUrl = (projectId: string, changeId?: string) => `/projects/${encodeURIComponent(projectId)}/changes${changeId ? `/${encodeURIComponent(changeId)}` : ""}`;
/** Deleted projects (todo16 D6), kept 30 days. */
export const deletedProjectsUrl = () => "/deleted-projects";
/** Pipeline runs (todo12 M1): under Data, like the Trash; `runId` opens one run. */
export const pipelinesUrl = (projectId: string, runId?: string) => `${projectUrl(projectId, "sources")}/pipelines${runId ? `/${encodeURIComponent(runId)}` : ""}`;
/** An alias of `filesUrl` (`/files/*` redirects there too). */
export const sourcesUrl = filesUrl;
export const exploreUrl = (projectId: string, tab?: string, proposalId?: string) => withQuery(`${projectUrl(projectId, "explore")}${tab ? `/${tab}` : ""}`, { proposal: proposalId });
/**
 * A dataset's subviews (docs/datasets.md §2.2). Overview is the dataset's own URL (`tasks` is its
 * old name); History keeps the `/versions` path and Publish `/publish`, so old links still work.
 */
export const DATASET_TABS = ["overview", "structure", "fields", "annotations", "quality", "versions", "publish"] as const;
export type DatasetTab = (typeof DATASET_TABS)[number];
export const datasetUrl = (projectId: string, datasetId: string, tab?: DatasetTab | "tasks") =>
  `${projectUrl(projectId, "datasets")}/${encodeURIComponent(datasetId)}${tab && tab !== "tasks" && tab !== "overview" ? `/${tab}` : ""}`;
export const versionReviewUrl = (projectId: string, datasetId: string, reviewId: string) => `${datasetUrl(projectId, datasetId, "versions")}/reviews/${encodeURIComponent(reviewId)}`;
export const studioUrl = (projectId: string, taskId?: string) => `${projectUrl(projectId, "studio")}${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
/** todo8 D7: the Task setup page (owners edit, annotators read). */
export const taskSetupUrl = (projectId: string, taskId: string) => `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/setup`;
export type ProjectSettingsTab = "general" | "members" | "rules" | "plugins";
export const settingsUrl = (projectId: string, tab: ProjectSettingsTab = "general") => `${projectUrl(projectId, "settings")}/${tab}`;

/** Organization, billing and personal settings, outside any project (laid out like the Nebius console). */
export type OrgPage = "members" | "projects" | "security" | "api-keys" | "audit-log" | "settings";
export type BillingPage = "usage" | "invoices" | "details";
export const orgUrl = (page: OrgPage = "members") => `/organization/${page}`;
export const billingUrl = (page: BillingPage = "usage") => `/billing/${page}`;
export const profileUrl = () => "/settings/profile";
/** Settings › Connected agents (todo17 M4): MCP clients acting for you. */
export const connectedAgentsUrl = () => "/settings/connected-agents";

function withQuery(path: string, query?: Record<string, string | undefined>): string {
  const q = Object.entries(query ?? {}).filter((e): e is [string, string] => !!e[1]);
  return q.length ? `${path}?${new URLSearchParams(q).toString()}` : path;
}

/** Where an attention row, an activity entry or an assistant link resolves (`ProjectTarget`). */
export function targetUrl(projectId: string, t: { section: string; nodeId?: string; importId?: string; proposalId?: string; tab?: string; taskId?: string; datasetId?: string; status?: string; reviewId?: string; runId?: string; changeId?: string }): string {
  switch (t.section) {
    case "pipelines":
      return pipelinesUrl(projectId, t.runId);
    case "sources":
    case "files":
      if (t.tab === "trash") return trashUrl(projectId);
      return filesUrl(projectId, t.nodeId, { import: t.importId, status: t.status });
    case "explore":
      return exploreUrl(projectId, t.tab, t.proposalId);
    case "datasets":
      if (t.datasetId && t.reviewId) return versionReviewUrl(projectId, t.datasetId, t.reviewId);
      return t.datasetId ? datasetUrl(projectId, t.datasetId, DATASET_TABS.find((x) => x === t.tab)) : projectUrl(projectId, "datasets");
    case "settings":
      return settingsUrl(projectId, t.tab === "plugins" || t.tab === "members" || t.tab === "rules" ? t.tab : "general");
    case "changes":
      return changesUrl(projectId, t.changeId);
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

/** Where an old `/projects/:p/files/*` URL goes now: the same node and query under `sources`. */
export function filesRedirect(pathname: string, search = ""): string {
  return pathname.replace(/^(\/projects\/[^/]+)\/files(?=\/|$)/, "$1/sources") + search;
}
