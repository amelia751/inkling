import { NAMING } from "@studio/contracts/naming";
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from "react-router";
import { useNoSwipeBack } from "@/studio/lib/use-no-swipe-back";
import { DatasetStudioPage } from "./routes/DatasetStudioPage";
import { StudioHostProvider } from "@/extension-host/host";
import { ReviewPage } from "./routes/ReviewPage";
import { DatasetDetailPage, DatasetsPage } from "./routes/DatasetsPage";
import { ProjectReviewPage } from "./routes/ProjectReviewPage";
import { ActivityPage } from "./routes/ActivityPage";
import { ProjectSettingsPage } from "./routes/ProjectSettingsPage";
import { TaskSetupPage } from "./routes/TaskSetupPage";
import { NotFoundPage, RouteError } from "./routes/errors";
import { HomePage } from "./routes/HomePage";
import { NewProjectPage, ProjectsPage } from "./routes/ProjectsPage";
import { ProjectOverviewPage } from "./routes/ProjectOverviewPage";
import { ExplorePage } from "./routes/ExplorePage";
import { FilesPage } from "./routes/FilesPage";
import { LEGACY, LegacyRedirect, SectionFrame, SourcesRedirect, StudioEntry } from "./routes/project-pages";
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
  { path: "/", element: <HomePage /> },
  { path: "/projects", element: <ProjectsPage /> },
  { path: "/projects/new", element: <NewProjectPage /> },
  { path: "/projects/:projectId", element: <Navigate to="overview" replace /> },
  { path: "/projects/:projectId/overview", element: <ProjectOverviewPage /> },
  // todo7 D11: the drive is "files"; `/sources/*` redirects keeping the node id and query.
  { path: "/projects/:projectId/files/trash", element: <FilesPage trash /> },
  // todo12 M1: pipeline runs live under Data (static segments win over `:nodeId`, as Trash does).
  { path: "/projects/:projectId/files/pipelines", element: <PipelineRunsPage /> },
  { path: "/projects/:projectId/files/pipelines/:runId", element: <PipelineRunPage /> },
  { path: "/projects/:projectId/files/:nodeId?", element: <FilesPage /> },
  { path: "/projects/:projectId/sources/*", element: <SourcesRedirect /> },
  { path: "/projects/:projectId/explore/:tab?", element: <ExplorePage /> },
  { path: "/projects/:projectId/datasets", element: <DatasetsPage /> },
  { path: "/projects/:projectId/datasets/:datasetId", element: <DatasetDetailPage tab="tasks" /> },
  { path: "/projects/:projectId/datasets/:datasetId/versions", element: <DatasetDetailPage tab="versions" /> },
  { path: "/projects/:projectId/datasets/:datasetId/versions/reviews/:reviewId", element: <VersionReviewPage /> },
  { path: "/projects/:projectId/datasets/:datasetId/publish", element: <DatasetDetailPage tab="publish" /> },
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
const router = createBrowserRouter([{ element: <Outlet />, errorElement: <RouteError />, children: routes }]);

export function AppShell() {
  // Trackpad swipes never navigate back (every page; the browser's Back button and ⌘[ still do).
  useNoSwipeBack();
  // Toasts ("Task setup changed · Undo" and the rest) come from boot.tsx's one app-wide Toaster.
  return <RouterProvider router={router} />;
}
