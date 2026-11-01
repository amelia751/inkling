/**
 * Dataset versioning in the Studio (todo4 Phase 6, V12): the versioned save flow on per-user
 * work branches, the top-bar work-state chip and "Request review" (todo8 D1), and the history,
 * review and release pages. Platform features, not plugins; type-specific diff previews
 * come from modules through the extension host's `diffPreview` registry.
 */
export { loadDocument, saveVersioned, StaleHeadError, useVersioning, versioningEnabled, reapply, commitStudioSetup } from "./session";
export { RequestReview, StaleNotice, useDraftHasChanges } from "./VersioningControls";
export { WorkStateChip } from "./WorkStateChip";
export { VersionsPage } from "./VersionsPage";
export { ReviewPage as VersionReviewPage } from "./ReviewPage";
