import { create } from "jsondiffpatch";
import { format, type Op } from "jsondiffpatch/formatters/jsonpatch";

/**
 * "Studio setup at this version" (todo10 Phase 2): what changed between two Studio
 * definitions (lockfile, environments, READMEs), as JSON Patch operations with the old value
 * alongside, so a person can read "task: classification → detection".
 */

// Array items keyed by their id (plugins, label classes, panels), so a reorder isn't a rewrite.
const differ = create({ objectHash: (o: object, i?: number) => String((o as { id?: unknown; name?: unknown }).id ?? (o as { name?: unknown }).name ?? `$${i}`), arrays: { detectMove: true } });

export interface StudioChange {
  op: Op["op"];
  path: string;
  before?: unknown;
  after?: unknown;
}

const at = (doc: unknown, pointer: string): unknown =>
  pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), doc);

export function studioChanges(before: unknown, after: unknown): StudioChange[] {
  const delta = differ.diff(before, after);
  if (!delta) return [];
  return format(delta).map((o) => ({
    op: o.op,
    path: o.path,
    ...(o.op === "remove" || o.op === "replace" ? { before: at(before, o.path) } : o.op === "move" ? { before: at(before, o.from) } : {}),
    ...(o.op === "add" || o.op === "replace" ? { after: o.value } : {}),
  }));
}

/** The comparable shape of a Studio setup: lockfile by plugin id, each task's environment and README. */
export function comparable(s: { lockfile?: { plugins: { id: string }[] } | null; tasks: Record<string, { environment?: unknown; readme?: string }> }) {
  return {
    plugins: Object.fromEntries((s.lockfile?.plugins ?? []).map((p) => [p.id, p])),
    tasks: s.tasks,
  };
}
