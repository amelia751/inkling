/**
 * todo18 P0-4: three-way merge of annotation documents per annotation id. When a save gets 409
 * (someone saved since we loaded), the Studio merges their document into ours: changes to
 * different annotations both survive; the same annotation changed on both sides is a conflict,
 * kept as "mine" until the person picks (the Theirs / Mine notice).
 */
import { create } from "zustand";
import type { Annotation } from "@studio/contracts/types";

export interface AnnotationConflict {
  id: string;
  mine?: Annotation; // undefined: I deleted it
  theirs?: Annotation; // undefined: they deleted it
}

const same = (a?: Annotation, b?: Annotation) => (a === b ? true : !a || !b ? false : JSON.stringify(a) === JSON.stringify(b));

export function mergeAnnotations(base: Annotation[], mine: Annotation[], theirs: Annotation[]): { merged: Annotation[]; conflicts: AnnotationConflict[] } {
  const B = new Map(base.map((a) => [a.id, a]));
  const M = new Map(mine.map((a) => [a.id, a]));
  const T = new Map(theirs.map((a) => [a.id, a]));
  const order = [...theirs.map((a) => a.id), ...mine.map((a) => a.id).filter((id) => !T.has(id))];
  const merged: Annotation[] = [];
  const conflicts: AnnotationConflict[] = [];
  for (const id of order) {
    const b = B.get(id), m = M.get(id), t = T.get(id);
    let pick: Annotation | undefined;
    if (same(m, b)) pick = t; // only they changed (or nobody)
    else if (same(t, b) || same(m, t)) pick = m; // only I changed, or we agree
    else {
      conflicts.push({ id, mine: m, theirs: t });
      pick = m ?? t; // keep the annotation visible until the person chooses
    }
    if (pick) merged.push(pick);
  }
  return { merged, conflicts };
}

/** Apply a Theirs / Mine choice for one conflicting annotation. */
export function resolveConflict(annotations: Annotation[], c: AnnotationConflict, choice: "mine" | "theirs"): Annotation[] {
  const want = choice === "mine" ? c.mine : c.theirs;
  const rest = annotations.filter((a) => a.id !== c.id);
  return want ? [...rest, want] : rest;
}

/** Open Theirs / Mine conflicts after a merged save (shown by the Studio's save notice). */
export const useSaveConflicts = create<{
  conflicts: AnnotationConflict[];
  /** The document as last loaded or saved for `baseProject`: the merge base on a 409. */
  base: Annotation[];
  baseProject: string | null;
  setBase: (projectId: string, annotations: Annotation[]) => void;
  set: (c: AnnotationConflict[]) => void;
  drop: (id: string) => void;
}>((set) => ({
  conflicts: [],
  base: [],
  baseProject: null,
  setBase: (baseProject, base) => set({ baseProject, base }),
  set: (conflicts) => set({ conflicts }),
  drop: (id) => set((s) => ({ conflicts: s.conflicts.filter((c) => c.id !== id) })),
}));
