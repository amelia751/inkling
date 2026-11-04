import { NAMING } from "@studio/contracts/naming";
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from "react-router";
import { useNoSwipeBack } from "@/studio/lib/use-no-swipe-back";
import { DatasetStudioPage } from "./routes/DatasetStudioPage";
import { StudioHostProvider } from "@/extension-host/host";
import { ReviewPage } from "./routes/ReviewPage";
import { DatasetLayout, DatasetsPage } from "@/studio/core/datasets";
import { ProjectReviewPage } from "./routes/ProjectReviewPage";
import { ActivityPage } from "./routes/ActivityPage";
import { ProjectSettingsPage } from "./routes/ProjectSettingsPage";
import { TaskSetupPage } from "./routes/TaskSetupPage";
import { NotFoundPage, RouteError } from "./routes/errors";
import { NewProjectHost } from "./entry/new-project-dialog";
import { ChatParamSync } from "./entry/home-chat";
import { ProjectsPage } from "./routes/ProjectsPage";
import { ProjectOverviewPage } from "./routes/ProjectOverviewPage";
import { ExplorePage } from "./routes/ExplorePage";
import { FilesPage } from "./routes/FilesPage";
import { TrashPage } from "./routes/TrashPage";
import { ChangesPage } from "./routes/ChangesPage";
import { ConnectedAgentsPage } from "./routes/settings/ConnectedAgentsPage";
import { DeletedProjectsPage } from "./routes/DeletedProjectsPage";
import { LEGACY, LegacyRedirect, SectionFrame, FilesRedirect, StudioEntry } from "./routes/project-pages";
import { VersionReviewPage } from "@/studio/core/versioning";
import { PipelineRunPage, PipelineRunsPage } from "@/studio/core/pipelines";
import { MembersPage } from "./routes/settings/MembersPage";
import { ApiKeysPage, AuditLogPage, OrgProjectsPage, OrgSettingsPage, SecurityPage } from "./routes/settings/OrgPages";
import { BillingDetailsPage, InvoicesPage, UsagePage } from "./routes/settings/BillingPages";
import { ProfilePage } from "./routes/settings/ProfilePage";

/**
 * Routes (todo6 Phase 2.1, docs/ux.md §11). Project and task ids are in the path; node ids,
 * never file paths, name files (paths can hold patient identifiers).
 */
const studio = (
  <StudioHostProvider>
    <DatasetStudioPage />
  </StudioHostProvider>
);

const routes = [
  { path: "/", element: <Navigate to="/projects" replace /> },
  { path: "/projects", element: <ProjectsPage /> },
  { path: "/deleted-projects", element: <DeletedProjectsPage /> },
  { path: "/projects/new", element: <Navigate to="/projects" replace /> },
  { path: "/projects/:projectId", element: <Navigate to="overview" replace /> },
  { path: "/projects/:projectId/overview", element: <ProjectOverviewPage /> },
  // The drive is "sources"; the old `/files/*` redirects keeping the node id and query.
  { path: "/projects/:projectId/trash", element: <TrashPage /> },
  // todo17 M2: change requests, beside Trash in the nav.
  { path: "/projects/:projectId/changes/:changeId?", element: <ChangesPage /> },
  { path: "/projects/:projectId/sources/trash", element: <FilesPage trash /> },
  // todo12 M1: pipeline runs live under Data (static segments win over `:nodeId`, as Trash does).
  { path: "/projects/:projectId/sources/pipelines", element: <PipelineRunsPage /> },
  { path: "/projects/:projectId/sources/pipelines/:runId", element: <PipelineRunPage /> },
  { path: "/projects/:projectId/sources/:nodeId?", element: <FilesPage /> },
  { path: "/projects/:projectId/files/*", element: <FilesRedirect /> },
  { path: "/projects/:projectId/explore/:tab?", element: <ExplorePage /> },
  { path: "/projects/:projectId/datasets", element: <DatasetsPage /> },
  // docs/datasets.md §2.2: Overview · Structure · Fields & Formats · Annotations · Quality · History.
  { path: "/projects/:projectId/datasets/:datasetId", element: <DatasetLayout tab="overview" /> },
  { path: "/projects/:projectId/datasets/:datasetId/structure", element: <DatasetLayout tab="structure" /> },
  { path: "/projects/:projectId/datasets/:datasetId/fields", element: <DatasetLayout tab="fields" /> },
  { path: "/projects/:projectId/datasets/:datasetId/annotations", element: <DatasetLayout tab="annotations" /> },
  { path: "/projects/:projectId/datasets/:datasetId/quality", element: <DatasetLayout tab="quality" /> },
  { path: "/projects/:projectId/datasets/:datasetId/versions", element: <DatasetLayout tab="versions" /> },
  { path: "/projects/:projectId/datasets/:datasetId/versions/reviews/:reviewId", element: <VersionReviewPage /> },
  { path: "/projects/:projectId/datasets/:datasetId/publish", element: <DatasetLayout tab="publish" /> },
  { path: "/projects/:projectId/studio", element: <StudioEntry /> },
  { path: "/projects/:projectId/studio/:taskId", element: studio },
  { path: "/projects/:projectId/tasks/:taskId/setup", element: <TaskSetupPage /> },
  { path: "/projects/:projectId/review", element: <ProjectReviewPage /> },
  { path: "/projects/:projectId/review/:taskId", element: <ReviewPage /> },
  { path: "/projects/:projectId/activity", element: <ActivityPage /> },
  { path: "/projects/:projectId/settings", element: <Navigate to="general" replace /> },
  { path: "/projects/:projectId/settings/:tab", element: <ProjectSettingsPage /> },
  { path: "/organization", element: <Navigate to="members" replace /> },
  { path: "/organization/members", element: <MembersPage /> },
  { path: "/organization/projects", element: <OrgProjectsPage /> },
  { path: "/organization/security", element: <SecurityPage /> },
  { path: "/organization/api-keys", element: <ApiKeysPage /> },
  { path: "/organization/audit-log", element: <AuditLogPage /> },
  { path: "/organization/settings", element: <OrgSettingsPage /> },
  { path: "/billing", element: <Navigate to="usage" replace /> },
  { path: "/billing/usage", element: <UsagePage /> },
  { path: "/billing/invoices", element: <InvoicesPage /> },
  { path: "/billing/details", element: <BillingDetailsPage /> },
  { path: "/settings", element: <Navigate to="profile" replace /> },
  { path: "/settings/profile", element: <ProfilePage /> },
  { path: "/settings/connected-agents", element: <ConnectedAgentsPage /> },
  // Before projects (todo6 D2 makes the ids line up): keep every old link working.
  { path: "/datasets/:datasetId", element: <LegacyRedirect to={LEGACY.studio} /> },
  { path: "/datasets/:datasetId/review", element: <LegacyRedirect to={LEGACY.review} /> },
  { path: "/datasets/:datasetId/plugins", element: <LegacyRedirect to={LEGACY.plugins} /> },
  { path: "/datasets/:datasetId/export", element: <LegacyRedirect to={LEGACY.export} /> },
  { path: "/datasets/:datasetId/versions", element: <LegacyRedirect to={LEGACY.versions} /> },
  { path: "/datasets/:datasetId/versions/reviews/:reviewId", element: <LegacyRedirect to={LEGACY.versionReview} /> },
  { path: "*", element: <NotFoundPage /> },
];

// One error element for every page: a render or loader error shows RouteError, not a blank tab.
// todo21: the new-project dialog and the `?chat=` reader are mounted once, inside the router.
const root = (
  <>
    <Outlet />
    <NewProjectHost />
    <ChatParamSync />
  </>
);
const router = createBrowserRouter([{ element: root, errorElement: <RouteError />, children: routes }]);

export function AppShell() {
  // Trackpad swipes never navigate back (every page; the browser's Back button and ⌘[ still do).
  useNoSwipeBack();
  // Toasts ("Task setup changed · Undo" and the rest) come from boot.tsx's one app-wide Toaster.
  return <RouterProvider router={router} />;
}
