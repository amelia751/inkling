import { labelClasses, type EnvironmentSpec, type LabelClass, type LabelGroup, type PanelSlots, type StudioView } from "@studio/contracts/environment";
import type { ProjectSummary } from "@studio/contracts/types";
import { formatCombo, normalizeCombo } from "@studio/ui/keys";
import type { ResolvedEnv } from "@/extension-host/resolve";
import type { Registered } from "@/extension-host/registry";

/**
 * Task setup (todo8 D7): the page's editable state (`SetupDraft`), built from a resolved
 * environment and turned back into the next spec. Everything is applied to the spec *as
 * written* (`env.source`), so a preset the task extends keeps supplying what wasn't changed.
 */

export interface SetupDraft {
  labels: LabelGroup[];
  panels: PanelSlots;
  /** Tool ids switched off (an `overrides` entry with `disabled: true`). */
  disabledTools: string[];
  /** Contribution id → config, for the forms (viewer, panels, exporters). */
  configs: Record<string, Record<string, unknown>>;
  studio: Required<StudioView>;
}

export const PANEL_SLOTS = ["left", "right", "bottom", "viewport-bar"] as const;
export type SetupPanelSlot = (typeof PANEL_SLOTS)[number];

/** Plain-word headings for the toolbar groups (the same words the toolbar and shortcuts sheet use). */
export const TOOL_GROUP_LABEL: Record<string, string> = { navigate: "Navigate", shape: "Shapes", measure: "Measure", mask: "Paint", time: "Time" };
export const TOOL_GROUP_ORDER = ["navigate", "shape", "measure", "mask", "time"];

/** Unset `showSourceLabels` means blind for classification (D8) and shown for everything else. */
export function studioDefaults(env: Pick<ResolvedEnv, "spec" | "task">): Required<StudioView> {
  const s = env.spec.studio ?? {};
  return { showSourceLabels: s.showSourceLabels ?? env.task !== "classification", showFilePaths: s.showFilePaths ?? true, itemNoun: s.itemNoun?.trim() ?? "" };
}

/** Tool ids the merged spec switches off (overrides apply in order, so the last word wins). */
export function disabledIds(spec: EnvironmentSpec): Set<string> {
  const out = new Set<string>();
  for (const o of spec.overrides ?? []) {
    if (o.disabled) out.add(o.id);
    else if (o.disabled === false) out.delete(o.id);
  }
  return out;
}

export function initialDraft(env: ResolvedEnv): SetupDraft {
  const disabled = disabledIds(env.spec);
  const configs: Record<string, Record<string, unknown>> = {};
  env.viewports.forEach((v) => (configs[v.renderer.id] = v.config));
  for (const [id, c] of Object.entries(env.configs)) configs[id] ??= c;
  return {
    labels: structuredClone(env.spec.labels ?? []),
    panels: Object.fromEntries(PANEL_SLOTS.map((s) => [s, [...(env.spec.panels?.[s] ?? [])]])) as PanelSlots,
    disabledTools: (env.spec.tools ?? []).filter((id) => disabled.has(id)),
    configs,
    studio: studioDefaults(env),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The spec as written after the page's edits; untouched parts stay exactly as they were. */
export function buildNextSpec(env: ResolvedEnv, draft: SetupDraft): EnvironmentSpec {
  const base = initialDraft(env);
  const next = structuredClone(env.source);

  // Labels: groups in the written spec replace same-named preset groups, so write them all.
  if (!same(base.labels, draft.labels)) next.labels = structuredClone(draft.labels);

  // Panels: a written slot list replaces the preset's.
  if (!same(base.panels, draft.panels)) {
    const panels: PanelSlots = { ...(next.panels ?? {}) };
    for (const s of PANEL_SLOTS) if (!same(base.panels[s], draft.panels[s])) panels[s] = [...(draft.panels[s] ?? [])];
    next.panels = panels;
  }

  // Tools: switch off with an override, switch back on by dropping it (or overriding the preset's).
  const was = new Set(base.disabledTools);
  const now = new Set(draft.disabledTools);
  let overrides = [...(next.overrides ?? [])];
  for (const id of new Set([...was, ...now])) {
    if (was.has(id) === now.has(id)) continue;
    overrides = overrides.flatMap((o) => {
      if (o.id !== id || o.disabled === undefined) return [o];
      const { disabled: _drop, ...keep } = o;
      return keep.config ? [keep] : [];
    });
    if (now.has(id)) overrides.push({ id, disabled: true });
    // Still off because a preset switches it off: say so explicitly.
    else if (disabledIds({ overrides: [...presetOverrides(env), ...overrides] }).has(id)) overrides.push({ id, disabled: false });
  }
  if (overrides.length || next.overrides) next.overrides = overrides;

  // Configs (viewer, panels, exporters).
  for (const [id, value] of Object.entries(draft.configs)) {
    if (same(base.configs[id], value)) continue;
    const vp = env.viewports.findIndex((v) => v.renderer.id === id);
    if (vp >= 0) {
      next.viewports = structuredClone(next.viewports ?? env.spec.viewports ?? []);
      next.viewports[vp] = { ...next.viewports[vp], config: value };
    } else {
      next.overrides = [
        ...(next.overrides ?? []).flatMap((o) => {
          if (o.id !== id || !o.config) return [o];
          const { config: _drop, ...keep } = o;
          return keep.disabled === undefined ? [] : [keep];
        }),
        { id, config: value },
      ];
    }
  }

  // Annotators see.
  if (!same(base.studio, draft.studio)) {
    const noun = draft.studio.itemNoun.trim().toLowerCase();
    const { itemNoun: _drop, ...rest } = { ...next.studio, ...draft.studio };
    next.studio = noun ? { ...rest, itemNoun: noun } : rest;
  }
  return next;
}

/** Overrides that come from presets only (the written spec's own are appended after them). */
function presetOverrides(env: ResolvedEnv): NonNullable<EnvironmentSpec["overrides"]> {
  const own = env.source.overrides?.length ?? 0;
  const all = env.spec.overrides ?? [];
  return all.slice(0, all.length - own);
}

// ---- Labels ----------------------------------------------------------------------------------

export const CHART_COLORS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The next unused chart color in a group, cycling once all five are taken. */
export function nextColor(group: LabelGroup): string {
  const used = new Set(group.classes.map((c) => c.color));
  return CHART_COLORS.find((c) => !used.has(c)) ?? CHART_COLORS[group.classes.length % CHART_COLORS.length];
}

export const classKey = (g: number, c: number) => `${g}:${c}`;

/**
 * Key problems per class (`classKey(group, class)` → message), checked as the resolver does:
 * against this task's tool keys, the commands that always listen, and the other classes. A
 * class on its own position's digit (the 3rd class on `3`) is the pick-by-number key, not a
 * conflict.
 */
export function hotkeyConflicts(labels: LabelGroup[], env: Pick<ResolvedEnv, "commands">, tools: Registered<"tools">[]): Map<string, string> {
  const out = new Map<string, string>();
  const flat = labelClasses(labels);
  const toolKeys = new Map(tools.filter((t) => t.hotkey).map((t) => [normalizeCombo(t.hotkey!), t.label]));
  const commandKeys = new Map<string, string>();
  for (const c of env.commands) if (!c.contextual) for (const k of c.keys) commandKeys.set(normalizeCombo(k), c.label);
  const byKey = new Map<string, LabelClass[]>();
  for (const c of flat) if (c.hotkey?.trim()) byKey.set(normalizeCombo(c.hotkey), [...(byKey.get(normalizeCombo(c.hotkey)) ?? []), c]);

  labels.forEach((g, gi) =>
    g.classes.forEach((c, ci) => {
      const raw = c.hotkey?.trim();
      if (!raw) return;
      let k: string;
      try {
        k = normalizeCombo(raw);
      } catch {
        return out.set(classKey(gi, ci), `“${raw}” isn't a key`);
      }
      const shown = formatCombo(raw);
      const tool = toolKeys.get(k);
      if (tool) return out.set(classKey(gi, ci), `${shown} is already the ${tool} tool's key`);
      const others = (byKey.get(k) ?? []).filter((o) => o.id !== c.id);
      if (others.length) return out.set(classKey(gi, ci), `${shown} is also ${others.map((o) => o.name ?? o.id).join(", ")}'s key`);
      const position = flat.findIndex((f) => f.id === c.id);
      const cmd = commandKeys.get(k);
      if (cmd && raw !== String(position + 1)) out.set(classKey(gi, ci), `${shown} already does “${cmd}”`);
    }),
  );
  return out;
}

/** Problems that keep the page from saving (beyond the resolver's own checks). */
export function labelProblems(labels: LabelGroup[]): string[] {
  const out: string[] = [];
  labels.forEach((g) => {
    const ids = g.classes.map((c) => c.id);
    if (ids.some((id) => !id)) out.push(`Every class in “${g.name}” needs a name.`);
    const dup = ids.find((id, i) => id && ids.indexOf(id) !== i);
    if (dup) out.push(`“${dup}” is in “${g.name}” twice.`);
  });
  return out;
}

/** Plain words for a label group's control. */
export function groupKind(g: LabelGroup): string {
  if (g.control === "Choices") return g.multiple ? "Any number of answers per item" : "One answer per item";
  const what: Record<string, string> = { RectangleLabels: "boxes", EllipseLabels: "ellipses", PolygonLabels: "polygons", KeyPointLabels: "points", BrushLabels: "painted masks", TimeSeriesLabels: "spans and moments", VideoRectangle: "tracked objects" };
  return `Labels for drawn ${what[g.control] ?? "regions"}`;
}

// ---- Who may change it ------------------------------------------------------------------------

/**
 * Owners edit Task setup; annotators read it. Projects have no member roles yet (the members
 * work is on the backlog), so this reads an optional `role` the API may send and otherwise
 * lets the person edit, as every other project page does today.
 */
export function canEditTaskSetup(summary: ProjectSummary | undefined): boolean {
  const role = (summary as (ProjectSummary & { role?: string }) | undefined)?.role;
  return role !== "annotator" && role !== "viewer";
}
