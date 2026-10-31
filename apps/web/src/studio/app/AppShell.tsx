import { NAMING } from "@studio/contracts/naming";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { useTheme } from "@/studio/lib/theme";
import { useNoSwipeBack } from "@/studio/lib/use-no-swipe-back";
import { DatasetStudioPage } from "./routes/DatasetStudioPage";
import { StudioHostProvider } from "@/extension-host/host";
import { ReviewPage } from "./routes/ReviewPage";
import { DatasetDetailPage, DatasetsPage } from "./routes/DatasetsPage";
import { ProjectReviewPage } from "./routes/ProjectReviewPage";
import { ActivityPage } from "./routes/ActivityPage";
import { ProjectSettingsPage } from "./routes/ProjectSettingsPage";
import { TaskSetupPage } from "./routes/TaskSetupPage";
import { FullPageMessage } from "./routes/shared";
import { HomePage } from "./routes/HomePage";
import { NewProjectPage, ProjectsPage } from "./routes/ProjectsPage";
import { ProjectOverviewPage } from "./routes/ProjectOverviewPage";
import { ExplorePage } from "./routes/ExplorePage";
import { SourcesPage } from "./routes/SourcesPage";
import { LEGACY, LegacyRedirect, SectionFrame, SourcesRedirect, StudioEntry } from "./routes/project-pages";
import { VersionReviewPage } from "@/studio/core/versioning";
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

const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/projects", element: <ProjectsPage /> },
  { path: "/projects/new", element: <NewProjectPage /> },
  { path: "/projects/:projectId", element: <Navigate to="overview" replace /> },
  { path: "/projects/:projectId/overview", element: <ProjectOverviewPage /> },
  // todo7 D11: the drive is "files"; `/sources/*` redirects keeping the node id and query.
  { path: "/projects/:projectId/files/trash", element: <SourcesPage /> },
  { path: "/projects/:projectId/files/:nodeId?", element: <SourcesPage /> },
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
  { path: "*", element: <FullPageMessage title="Page not found" /> },
]);

export function AppShell() {
  // Trackpad swipes never navigate back (every page; the browser's Back button and ⌘[ still do).
  useNoSwipeBack();
  const { theme } = useTheme();
  return (
    <>
      <RouterProvider router={router} />
      {/* Toasts with an action ("Task setup changed · Undo"), bottom-left, clear of the assistant. */}
      <Toaster position="bottom-left" theme={theme} />
    </>
  );
}
