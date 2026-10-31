/**
 * Project URLs (todo6 Phase 2.1). Project and task ids live in the path; safe selections (a
 * tab, a view mode) go in the query; file names and other patient-ish strings never do
 * (node ids instead: docs/ux.md §11).
 */
export type ProjectSection = "overview" | "sources" | "explore" | "datasets" | "studio" | "review" | "activity" | "settings";

export const homeUrl = () => "/";
export const projectsUrl = () => "/projects";
export const newProjectUrl = () => "/projects/new";
export const projectUrl = (projectId: string, section: ProjectSection = "overview") => `/projects/${encodeURIComponent(projectId)}/${section}`;
export const sourcesUrl = (projectId: string, nodeId?: string | null, query?: Record<string, string | undefined>) => withQuery(`${projectUrl(projectId, "sources")}${nodeId ? `/${encodeURIComponent(nodeId)}` : ""}`, query);
export const exploreUrl = (projectId: string, tab?: string, proposalId?: string) => withQuery(`${projectUrl(projectId, "explore")}${tab ? `/${tab}` : ""}`, { proposal: proposalId });
export const datasetUrl = (projectId: string, datasetId: string, tab?: "tasks" | "versions" | "publish") => `${projectUrl(projectId, "datasets")}/${encodeURIComponent(datasetId)}${tab && tab !== "tasks" ? `/${tab}` : ""}`;
export const versionReviewUrl = (projectId: string, datasetId: string, reviewId: string) => `${datasetUrl(projectId, datasetId, "versions")}/reviews/${encodeURIComponent(reviewId)}`;
export const studioUrl = (projectId: string, taskId?: string) => `${projectUrl(projectId, "studio")}${taskId ? `/${encodeURIComponent(taskId)}` : ""}`;
export const settingsUrl = (projectId: string, tab: "general" | "plugins" | "members" = "general") => `${projectUrl(projectId, "settings")}/${tab}`;

/** Organization, billing and personal settings, outside any project (laid out like the Nebius console). */
export type OrgPage = "members" | "projects" | "security" | "api-keys" | "audit-log" | "settings";
export type BillingPage = "usage" | "invoices" | "details";
export const orgUrl = (page: OrgPage = "members") => `/organization/${page}`;
export const billingUrl = (page: BillingPage = "usage") => `/billing/${page}`;
export const profileUrl = () => "/settings/profile";

function withQuery(path: string, query?: Record<string, string | undefined>): string {
  const q = Object.entries(query ?? {}).filter((e): e is [string, string] => !!e[1]);
  return q.length ? `${path}?${new URLSearchParams(q).toString()}` : path;
}

/** Where an attention row, an activity entry or an assistant link resolves (`ProjectTarget`). */
export function targetUrl(projectId: string, t: { section: string; nodeId?: string; importId?: string; proposalId?: string; tab?: string; taskId?: string; datasetId?: string; status?: string; reviewId?: string }): string {
  switch (t.section) {
    case "sources":
      return sourcesUrl(projectId, t.nodeId, { import: t.importId, status: t.status });
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
