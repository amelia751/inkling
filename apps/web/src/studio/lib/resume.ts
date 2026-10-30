import type { Placement, Plane } from "@studio/contracts/types";

/** Resume helpers for the Studio (todo6 D9, Phase 7; the hook is `useResume` in DatasetStudioPage). */

// The page this document was loaded on, and whether that load was a reload.
const bootPath = typeof window !== "undefined" ? window.location.pathname : "";
const bootReload = typeof performance !== "undefined" && (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";
let reloadRestored = false;

/**
 * The Studio at `pathname` was reloaded in the browser (not reached in the app), and its
 * resume hasn't been restored yet in this document.
 */
export function openedByReload(pathname: string): boolean {
  return bootReload && !reloadRestored && pathname === bootPath;
}

export function markReloadRestored(): void {
  reloadRestored = true;
}

/**
 * Where the person is in an item, from what the renderer publishes: `playhead` ({ frame,
 * slice? }: video, cine) and the volume's `viewportState` ({ activePlane, slices }).
 */
export function placementOf(playhead: { frame?: number; slice?: number } | undefined, view: { activePlane?: Plane; slices?: Partial<Record<Plane, number>> } | undefined): Placement {
  const out: Placement = {};
  if (typeof playhead?.frame === "number") out.frame = playhead.frame;
  if (typeof playhead?.slice === "number") out.slice = playhead.slice;
  const plane = view?.activePlane;
  const slice = plane ? view?.slices?.[plane] : undefined;
  if (plane && typeof slice === "number") {
    out.plane = plane;
    out.slice = slice;
  }
  return out;
}
