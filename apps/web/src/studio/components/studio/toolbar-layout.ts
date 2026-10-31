import type { ToolGroup } from "@studio/plugin-ui-sdk/module";

/**
 * How the canvas toolbar lays out the environment's tools (todo8 D4 Rule 2):
 * - navigation tools stay expanded, except the ones in `VIEW_ONLY` (Zoom: scroll already
 *   zooms, so it lives with the view controls and its key; it shows while it's active);
 * - every other group with 3 or more tools folds into one split button whose face is the
 *   active tool, else the group's last used one, else its first;
 * - groups with 1 or 2 tools stay expanded.
 * Keys never change: they are the tools' own hotkeys.
 */
export const FOLD_AT = 3;
const VIEW_ONLY = new Set(["zoom"]);

/** Headings for tool groups, shared by the split buttons' menus and the shortcuts sheet. */
export const GROUP_TITLES: Record<ToolGroup, string> = { navigate: "Navigate", shape: "Shapes", measure: "Measure", mask: "Paint", time: "Time" };

export interface ToolLike {
  name: string;
  group: ToolGroup;
}

export type ToolbarSegment<T extends ToolLike> =
  | { kind: "tools"; group: ToolGroup; tools: T[] }
  | { kind: "fold"; group: ToolGroup; face: T; tools: T[] };

/** Group `tools` by `group` in first-appearance order. */
export function groupTools<T extends ToolLike>(tools: T[]): { group: ToolGroup; tools: T[] }[] {
  const out: { group: ToolGroup; tools: T[] }[] = [];
  for (const t of tools) {
    const g = out.find((x) => x.group === t.group);
    if (g) g.tools.push(t);
    else out.push({ group: t.group, tools: [t] });
  }
  return out;
}

export function toolbarLayout<T extends ToolLike>(tools: T[], active: string | undefined, lastUsed: Partial<Record<string, string>> = {}): ToolbarSegment<T>[] {
  return groupTools(tools).flatMap(({ group, tools: list }): ToolbarSegment<T>[] => {
    if (group === "navigate") {
      const shown = list.filter((t) => !VIEW_ONLY.has(t.name) || t.name === active);
      return shown.length ? [{ kind: "tools", group, tools: shown }] : [];
    }
    if (list.length < FOLD_AT) return [{ kind: "tools", group, tools: list }];
    const face = list.find((t) => t.name === active) ?? list.find((t) => t.name === lastUsed[group]) ?? list[0];
    return [{ kind: "fold", group, face, tools: list }];
  });
}
