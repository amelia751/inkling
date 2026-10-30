import { createBrowserRouter, RouterProvider } from "react-router";
import { useNoSwipeBack } from "@/lib/use-no-swipe-back";
import { DatasetStudioPage } from "./routes/DatasetStudioPage";
import { ExportPage } from "./routes/ExportPage";
import { ReviewPage } from "./routes/ReviewPage";
import { FullPageMessage } from "./routes/shared";
import { WorkspacePage } from "./routes/WorkspacePage";

const router = createBrowserRouter([
  { path: "/", element: <WorkspacePage /> },
  { path: "/datasets/:datasetId", element: <DatasetStudioPage /> },
  { path: "/datasets/:datasetId/review", element: <ReviewPage /> },
  { path: "/datasets/:datasetId/export", element: <ExportPage /> },
  { path: "*", element: <FullPageMessage title="Page not found" /> },
]);

export function AppShell() {
  // Trackpad swipes never navigate back (every page; the browser's Back button and ⌘[ still do).
  useNoSwipeBack();
  return <RouterProvider router={router} />;
}
