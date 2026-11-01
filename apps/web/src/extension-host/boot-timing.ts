import { RES } from "@studio/contracts/naming";
import { BOOT_MARK_PREFIX, markBootOnce } from "@studio/plugin-ui-sdk/perf";

/**
 * The Studio boot timeline (todo11 Milestone 1 §1). Each step is a `performance` mark named
 * `<resourcePrefix>:boot:<step>`:
 *
 * - `route-enter`: the Studio route rendered for a task (starts a boot; earlier marks clear);
 * - `env-fetched`, `env-resolved`: the environment document arrived, then resolved;
 * - `shell-painted`: the Studio chrome (top bar, layout, slots) is on screen;
 * - `module:<id>` / `module-failed:<id>`: each module's implementation loaded (or didn't);
 * - `items-painted`: the items rail drew its first row;
 * - `first-frame`: the viewer drew the first item (renderers call `markFirstFrame`).
 *
 * `bootTimeline()` reads them back relative to navigation start and to `route-enter`; the
 * dev overlay and `tools/boot-timeline.py` show it.
 */
export type BootStep = { step: string; at: number; sinceRoute: number; detail?: unknown };

export interface BootTimeline {
  taskId: string | null;
  /** True when the boot began with this page load (no earlier SPA route in this document). */
  cold: boolean;
  routeEnter: number | null;
  steps: BootStep[];
}

let current: { taskId: string; cold: boolean; at: number } | null = null;

/**
 * Start a boot for a task: clears the previous boot's marks and marks `route-enter`. Called
 * from render, so a repeat for the same task within a moment (StrictMode) is ignored.
 */
export function startBoot(taskId: string): void {
  if (typeof performance === "undefined") return;
  const now = performance.now();
  if (current?.taskId === taskId && now - current.at < 250) return;
  current = { taskId, cold: current === null, at: now };
  for (const m of performance.getEntriesByType("mark")) if (m.name.startsWith(BOOT_MARK_PREFIX)) performance.clearMarks(m.name);
  markBootOnce("route-enter", { taskId });
}

/** Mark a step of the current boot once (later calls for the same step are ignored). */
export function markBoot(step: string, detail?: Record<string, unknown>): void {
  markBootOnce(step, detail);
}

/** Mark after the browser has painted what was just committed (two frames: commit, then paint). */
export function markAfterPaint(step: string, detail?: Record<string, unknown>): void {
  if (typeof requestAnimationFrame === "undefined") return markBoot(step, detail);
  requestAnimationFrame(() => requestAnimationFrame(() => markBoot(step, detail)));
}

export function bootTimeline(): BootTimeline {
  const marks = typeof performance === "undefined" ? [] : performance.getEntriesByType("mark").filter((m) => m.name.startsWith(BOOT_MARK_PREFIX));
  const route = marks.find((m) => m.name === `${BOOT_MARK_PREFIX}route-enter`)?.startTime ?? null;
  return {
    taskId: current?.taskId ?? null,
    cold: current?.cold ?? true,
    routeEnter: route,
    steps: marks
      .map((m) => ({ step: m.name.slice(BOOT_MARK_PREFIX.length), at: Math.round(m.startTime), sinceRoute: Math.round(m.startTime - (route ?? 0)), detail: (m as PerformanceMark).detail ?? undefined }))
      .sort((a, b) => a.at - b.at),
  };
}

// The timeline script (tools/boot-timeline.py) and the e2e budgets read it from the page.
if (typeof window !== "undefined") (window as unknown as Record<string, unknown>)[`__${RES}BootTimeline`] = bootTimeline;
