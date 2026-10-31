import { labelClasses } from "@studio/contracts/environment";
import type { Project, StudioItem } from "@studio/contracts/types";
import { studioDefaults } from "./task-setup";
import type { ResolvedEnv } from "@studio/plugin-ui-sdk/resolved";

/**
 * Items follow the file system (todo8 D3, D8). Pure helpers for the Items panel, the status
 * bar's path and the hover card: where an item sits in Data, how two items with the same
 * name are told apart, what the queue's status chips count, and whether this task may show
 * the labels that came with the files.
 */

/** Per item: a person annotated it; imported labels or AI suggestions only; or nothing. */
export type ItemState = "annotated" | "imported" | "suggested" | "todo";

/** Queue chips: All · To do · Needs review (AI + imported) · Done. */
export type QueueFilter = "all" | "todo" | "review" | "done";

export const QUEUE_FILTERS: { id: QueueFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "todo", label: "To do" },
  { id: "review", label: "Needs review" },
  { id: "done", label: "Done" },
];

export function inQueue(state: ItemState, filter: QueueFilter): boolean {
  if (filter === "all") return true;
  if (filter === "todo") return state === "todo";
  if (filter === "review") return state === "imported" || state === "suggested";
  return state === "annotated";
}

const commonPrefix = (lists: string[][]): string[] => {
  if (!lists.length) return [];
  const out = [...lists[0]];
  for (const l of lists) {
    let k = 0;
    while (k < out.length && k < l.length && out[k] === l[k]) k++;
    out.length = k;
  }
  return out;
};

/**
 * Fill `folder` and `nodeId` from the item's assets (the kernel's task document gives each
 * asset its folder below the task's common folder). A bundle (a study, a series) lives where
 * its files' common folder is; when that folder *is* the item (same name), the item sits in
 * its parent instead, so a series isn't a folder holding only itself. The folders shared by
 * every item are stripped again, so the tree starts where items differ. Items whose assets
 * carry no folder (the seed stand-in without the API) keep none: they fall back to `group`.
 */
export function withFolders(items: StudioItem[]): StudioItem[] {
  const filled = items.map((item) => {
    const nodeId = item.nodeId ?? item.assets.find((a) => a.nodeId)?.nodeId;
    if (item.folder) return nodeId === item.nodeId ? item : { ...item, nodeId };
    const lists = item.assets.map((a) => a.folder).filter((f): f is string[] => Array.isArray(f));
    if (!lists.length) return nodeId === item.nodeId ? item : { ...item, nodeId };
    const folder = item.assets.length > 1 ? commonPrefix(lists) : lists[0];
    if (item.assets.length > 1 && folder.length && folder[folder.length - 1] === item.name) folder.pop();
    return { ...item, folder: [...folder], nodeId };
  });
  const shared = commonPrefix(filled.filter((i) => i.folder).map((i) => i.folder!));
  if (!shared.length || filled.some((i) => !i.folder)) return filled;
  return filled.map((i) => ({ ...i, folder: i.folder!.slice(shared.length) }));
}

/**
 * D8, blind by default: a classification task hides the labels that came with the files
 * (no grouping, no status bar, no hover card) unless Task setup turns them on
 * (`env.spec.studio.showSourceLabels`, defaults from `studioDefaults`). Other kinds show them
 * as context in the hover card only.
 */
export function showSourceLabels(env: Pick<ResolvedEnv, "spec" | "task">): boolean {
  return studioDefaults(env).showSourceLabels;
}

/** Folder paths in the status bar and the hover card (Task setup → Annotators see → file paths). */
export function showFilePaths(env: Pick<ResolvedEnv, "spec" | "task">): boolean {
  return studioDefaults(env).showFilePaths;
}

/**
 * What a blind task shows of folders: a folder named like an item's source label or one of
 * the task's classes (`normal/`, `pneumonia/`) is the answer, so it's left out. Returns the
 * items unchanged when source labels may be shown.
 */
export function blindFolders(items: StudioItem[], hidden: Iterable<string>, show: boolean): StudioItem[] {
  if (show) return items;
  const words = new Set<string>();
  for (const w of hidden) if (w) words.add(w.toLowerCase());
  for (const i of items) if (i.sourceLabel) words.add(i.sourceLabel.toLowerCase());
  if (!words.size) return items;
  const out = items.map((i) => (i.folder?.some((s) => words.has(s.toLowerCase())) ? { ...i, folder: i.folder.filter((s) => !words.has(s.toLowerCase())) } : i));
  return withFolders(out);
}

/** How many distinct folders the items sit in (Folders is the default view above one). */
export function folderCount(items: Pick<StudioItem, "folder">[]): number {
  return new Set(items.map((i) => (i.folder ?? []).join("\u0000"))).size;
}

/**
 * VS Code-style disambiguation: for each item whose name another item shares (ignoring
 * case), the shortest run of its parent folders, ending at its own folder, that no other
 * same-named item has: `IM-0001.dcm  patient_07/series_2`. Unique names get "". When no
 * suffix tells two items apart (the same folder), the full folder is given.
 */
export function disambiguate(items: Pick<StudioItem, "name" | "folder">[]): string[] {
  const byName = new Map<string, number[]>();
  items.forEach((it, i) => {
    const k = it.name.toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), i]);
  });
  const out = items.map(() => "");
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const folders = group.map((i) => items[i].folder ?? []);
    const suffix = (f: string[], k: number) => f.slice(Math.max(0, f.length - k)).join("/");
    group.forEach((idx, gi) => {
      const mine = folders[gi];
      let k = 1;
      for (; k <= mine.length; k++) {
        const s = suffix(mine, k);
        if (folders.every((f, j) => j === gi || suffix(f, k) !== s)) break;
      }
      out[idx] = mine.length ? suffix(mine, Math.min(k, mine.length)) : "";
    });
  }
  return out;
}

// ---- The Folders view's tree --------------------------------------------------------------

export interface ItemDir {
  /** `dir:<segments joined>` (paths only in memory, never in a URL). */
  id: string;
  /** What the row says: a compact chain of single-child folders reads `mri / patient_07`. */
  name: string;
  /** The folder's segments below the task's common folder. */
  path: string[];
  dirs: ItemDir[];
  /** Leaves: item indices, or a numbered run of them. */
  leaves: ItemLeaf[];
  /** Items below, and how many of them are done (annotated by a person). */
  total: number;
  done: number;
}

export type ItemLeaf = { kind: "item"; index: number } | { kind: "run"; id: string; name: string; indices: number[] };

/** Numbered runs (`IM-0001.png`, `IM-0002.png`, …) of at least this many collapse into one row, as in Data. */
export const MIN_RUN = 3;

const runKey = (name: string) => (/\d+(?=\D*$)/.test(name) ? name.replace(/\d+(?=\D*$)/, "#") : null);

/**
 * The task's items as a folder tree: folders first then items, each sorted by name (numeric
 * aware), single-child folder chains compacted, numbered runs collapsed. `indices` limits the
 * tree to some items (a filter); `states` gives the done counts.
 */
export function itemTree(items: StudioItem[], states: Map<string, ItemState>, indices?: number[]): ItemDir {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const root: ItemDir = { id: "dir:", name: "", path: [], dirs: [], leaves: [], total: 0, done: 0 };
  const dirOf = (path: string[]): ItemDir => {
    let cur = root;
    for (let i = 0; i < path.length; i++) {
      let next = cur.dirs.find((d) => d.path[i] === path[i]);
      if (!next) {
        next = { id: `dir:${path.slice(0, i + 1).join("\u0000")}`, name: path[i], path: path.slice(0, i + 1), dirs: [], leaves: [], total: 0, done: 0 };
        cur.dirs.push(next);
      }
      cur = next;
    }
    return cur;
  };
  for (const index of indices ?? items.map((_, i) => i)) {
    const item = items[index];
    const path = item.folder ?? [];
    const done = states.get(item.id) === "annotated" ? 1 : 0;
    let cur = root;
    cur.total++;
    cur.done += done;
    for (let i = 0; i < path.length; i++) {
      cur = dirOf(path.slice(0, i + 1));
      cur.total++;
      cur.done += done;
    }
    cur.leaves.push({ kind: "item", index });
  }
  const finish = (d: ItemDir) => {
    d.dirs.sort((a, b) => collator.compare(a.name, b.name));
    d.dirs.forEach(finish);
    // Compaction: a folder holding exactly one folder and no items merges with it.
    d.dirs = d.dirs.map((c) => {
      let cur = c;
      const names = [c.name];
      while (cur.dirs.length === 1 && !cur.leaves.length) {
        cur = cur.dirs[0];
        names.push(cur.name);
      }
      return cur === c ? c : { ...cur, name: names.join(" / ") };
    });
    const leaves = (d.leaves as { kind: "item"; index: number }[]).sort((a, b) => collator.compare(items[a.index].name, items[b.index].name));
    const runs = new Map<string, number[]>();
    for (const l of leaves) {
      const k = runKey(items[l.index].name);
      if (k) runs.set(k, [...(runs.get(k) ?? []), l.index]);
    }
    const out: ItemLeaf[] = [];
    const placed = new Set<string>();
    for (const l of leaves) {
      const k = runKey(items[l.index].name);
      const run = k ? runs.get(k)! : null;
      if (k && run && run.length >= MIN_RUN) {
        if (placed.has(k)) continue;
        placed.add(k);
        out.push({ kind: "run", id: `run:${d.path.join("\u0000")}:${k}`, name: `${items[run[0]].name}–${items[run[run.length - 1]].name}`, indices: run });
      } else out.push(l);
    }
    d.leaves = out;
  };
  finish(root);
  return root;
}

/** The ids of the folders (and runs) above an item, outermost first, for revealing it. */
export function dirsAbove(tree: ItemDir, index: number): string[] {
  const walk = (d: ItemDir, trail: string[]): string[] | null => {
    for (const l of d.leaves) {
      if (l.kind === "item" && l.index === index) return trail;
      if (l.kind === "run" && l.indices.includes(index)) return [...trail, l.id];
    }
    for (const c of d.dirs) {
      const hit = walk(c, [...trail, c.id]);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree, []) ?? [];
}

/** True when `folder` starts with `prefix` (the status bar's path filter). */
export function inFolder(folder: string[] | undefined, prefix: string[]): boolean {
  const f = folder ?? [];
  return prefix.length <= f.length && prefix.every((s, i) => f[i] === s);
}

/** Whether the task mixes data kinds (the kind icon only shows then). */
export function mixesKinds(kinds: (string | undefined)[]): boolean {
  return new Set(kinds.map((k) => k ?? "")).size > 1;
}

/**
 * The Studio's items for a task document: the data kind's grouping, then each item's Data
 * folder and node (D3), with label-named folders left out when the task is blind (D8).
 */
export function studioItems(project: Project, env: Pick<ResolvedEnv, "spec" | "task" | "labels" | "dataKind">): StudioItem[] {
  const items = withFolders(env.dataKind.groupItems(project));
  const classes = labelClasses(env.labels).flatMap((c) => [c.id, ...(c.name ? [c.name] : [])]);
  return blindFolders(items, classes, showSourceLabels(env));
}
