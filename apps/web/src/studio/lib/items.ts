import type { Project, StudioItem } from "@studio/contracts/types";
import { envOf } from "./environment";

/** Group a project's raw assets into the items an expert annotates one at a time (the env's data kind decides how). */
export function projectItems(project: Project): StudioItem[] {
  return envOf(project)?.dataKind.groupItems(project) ?? [];
}

/**
 * The next item nobody has annotated yet, after `from` in queue order (the task's item order
 * for now), wrapping around; undefined when every other item has annotations. Used by the
 * `nextTodo` command (N) and the decision bar's advance.
 */
export function nextTodoIndex(items: StudioItem[], annotations: readonly { itemId: string }[], from: number): number | undefined {
  const done = new Set(annotations.map((a) => a.itemId));
  for (let step = 1; step < items.length; step++) {
    const i = (from + step) % items.length;
    if (!done.has(items[i].id)) return i;
  }
  return undefined;
}
