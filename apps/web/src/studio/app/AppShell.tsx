import { NAMING } from "@studio/contracts/naming";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { useNoSwipeBack } from "@/studio/lib/use-no-swipe-back";
import { DatasetStudioPage } from "./routes/DatasetStudioPage";
import { StudioHostProvider } from "@/extension-host/host";
import { ExportPage } from "./routes/ExportPage";
import { ReviewPage } from "./routes/ReviewPage";
import { PluginsPage } from "./routes/PluginsPage";
import { FullPageMessage } from "./routes/shared";
import { HomePage } from "./routes/HomePage";
import { NewProjectPage, ProjectsPage } from "./routes/ProjectsPage";
import { ProjectOverviewPage } from "./routes/ProjectOverviewPage";
import { LEGACY, LegacyRedirect, SectionFrame, StudioEntry } from "./routes/project-pages";
import { VersionReviewPage, VersionsPage } from "@/studio/core/versioning";

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
  { path: "/projects/:projectId/sources/:nodeId?", element: <SectionFrame title="Sources" description="The files you brought, exactly as uploaded." /> },
  { path: "/projects/:projectId/explore/:tab?", element: <SectionFrame title="Explore" description={`What ${NAMING.displayName} found in your files and how they fit together.`} /> },
  { path: "/projects/:projectId/datasets", element: <SectionFrame title="Datasets" description="The datasets and tasks built from your sources." /> },
  { path: "/projects/:projectId/datasets/:datasetId", element: <SectionFrame title="Dataset" description="Its tasks, versions and exports." /> },
  { path: "/projects/:projectId/datasets/:datasetId/versions", element: <VersionsPage /> },
  { path: "/projects/:projectId/datasets/:datasetId/versions/reviews/:reviewId", element: <VersionReviewPage /> },
  { path: "/projects/:projectId/datasets/:datasetId/publish", element: <ExportPage /> },
  { path: "/projects/:projectId/studio", element: <StudioEntry /> },
  { path: "/projects/:projectId/studio/:taskId", element: studio },
  { path: "/projects/:projectId/review", element: <ReviewPage /> },
  { path: "/projects/:projectId/activity", element: <SectionFrame title="Activity" description="Who changed what, and when." /> },
  { path: "/projects/:projectId/settings", element: <Navigate to="general" replace /> },
  { path: "/projects/:projectId/settings/plugins", element: <PluginsPage /> },
  { path: "/projects/:projectId/settings/:tab", element: <SectionFrame title="Settings" description="The project's name, description, visibility and members." /> },
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
  return <RouterProvider router={router} />;
}
