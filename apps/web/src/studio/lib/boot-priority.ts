import { RES } from "@studio/contracts/naming";
import type { EnvironmentSpec } from "@studio/contracts/environment";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment, type ResolvedEnv } from "@/extension-host/resolve";

/**
 * Module load order for a Studio boot (todo11 Milestone 1 §3): the viewer's module first,
 * then the panels on screen, then everything else once the viewer is in (idle time). Slots
 * that mount earlier still load their own module on demand (ModuleSlot), so order is a
 * priority, never a gate.
 */

const unique = (ids: (string | undefined)[]) => [...new Set(ids.filter((x): x is string => !!x))];

/** Modules of the environment's viewport renderers. */
export const viewerModules = (env: ResolvedEnv): string[] => unique(env.viewports.map((v) => v.renderer.module));

/** Modules of panels visible when the Studio opens: the first tab of each tabbed slot, every viewer-bar panel. */
export const visiblePanelModules = (env: ResolvedEnv): string[] =>
  unique([env.panels.left[0], env.panels.right[0], env.panels.bottom[0], ...env.panels["viewport-bar"]].map((p) => p?.module));

/** Only modules this build has registered (a remote plugin may not be loaded yet). */
const known = (ids: string[]) => ids.filter((id) => !!registry.availableModule(id));

const whenIdle = (fn: () => void) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 1500 });
  else setTimeout(fn, 50);
};

/** Start loading an environment's modules in priority order. */
export function loadInPriority(env: ResolvedEnv, taskId?: string): void {
  const viewer = known(viewerModules(env));
  if (taskId) rememberViewer(taskId, viewer);
  viewer.forEach((id) => registry.ensure(id));
  known(visiblePanelModules(env)).forEach((id) => registry.ensure(id));
  const rest = known(env.modules.map((m) => m.id));
  void Promise.allSettled(viewer.map((id) => registry.preload(id))).then(() => whenIdle(() => rest.forEach((id) => registry.ensure(id))));
}

/**
 * The viewer chunk as early as possible: from the spec alone, before the workspace applies and
 * the environment resolves for real. Errors here are ignored; the real resolve reports them.
 */
export function warmFromSpec(spec: EnvironmentSpec | null | undefined): void {
  if (!spec) return;
  try {
    const r = resolveEnvironment(spec, registry);
    if (!r.errors) known(viewerModules(r.env)).forEach((id) => registry.ensure(id));
  } catch {
    /* resolved properly later */
  }
}

// On route enter we don't know the environment yet; the viewer this task used last time is a
// good guess (a per-browser convenience; a wrong guess only loads a chunk early).
const hintKey = (taskId: string) => `${RES}.boot.viewer.${taskId}`;

function rememberViewer(taskId: string, modules: string[]) {
  try {
    localStorage.setItem(hintKey(taskId), JSON.stringify(modules));
  } catch {
    /* storage blocked */
  }
}

/** Route enter: start the viewer module this task used last time, if any. */
export function warmFromHint(taskId: string): void {
  try {
    const ids = JSON.parse(localStorage.getItem(hintKey(taskId)) ?? "[]") as unknown;
    if (Array.isArray(ids)) known(ids.filter((x): x is string => typeof x === "string")).forEach((id) => registry.ensure(id));
  } catch {
    /* storage blocked or bad value */
  }
}

/** Modules in `next` that aren't loaded yet (what a live environment change has to fetch). */
export const newModules = (next: ResolvedEnv): string[] => known(next.modules.map((m) => m.id)).filter((id) => !registry.isLoaded(id));
