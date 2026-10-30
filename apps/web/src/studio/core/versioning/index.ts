/**
 * Dataset versioning in the Studio (todo4 Phase 6, V12): the versioned save flow on per-user
 * work branches, the top-bar branch switcher and "Submit for review", and the history,
 * review and release pages. Platform features, not plugins; type-specific diff previews
 * come from modules through the extension host's `diffPreview` registry.
 */
export { loadDocument, saveVersioned, StaleHeadError, useVersioning, versioningEnabled, reapply } from "./session";
export { VersioningControls } from "./VersioningControls";
export { VersionsPage } from "./VersionsPage";
export { ReviewPage as VersionReviewPage } from "./ReviewPage";
