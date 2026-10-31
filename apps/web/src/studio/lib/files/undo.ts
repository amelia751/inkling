import { create } from "zustand";

/**
 * Undo labels for this tab (todo7 D9, Phase 4). The truth is the server's journal (`fs/undo`
 * undoes the caller's last batch, whichever tab made it); the tab only remembers the batch ids
 * and labels of what it did, so menus can say "Undo move of 3 items" without a request. After a
 * reload, `useFsHistory` gives the server's hint instead.
 */
export interface TabBatch {
  batchId: string;
  projectId: string;
  /** "Moved 3 items to MRI" (the server's summary). */
  label: string;
  at: number;
}

interface UndoState {
  /** Newest last; at most 50. */
  done: TabBatch[];
  /** Undone by this tab, newest last (redo stack). */
  undone: TabBatch[];
  record: (b: Omit<TabBatch, "at">) => void;
  /** The server undid `batchId` (by us, from any surface). */
  markUndone: (batchId: string) => void;
  markRedone: (batchId: string) => void;
  clear: (projectId?: string) => void;
  /** Batches this tab caused that aren't undo steps of their own (the undo and redo batches), newest last. */
  own: string[];
  noteOwn: (batchId: string) => void;
}

const MAX = 50;

export const useTabUndo = create<UndoState>((set) => ({
  done: [],
  undone: [],
  own: [],
  noteOwn: (batchId) => set((s) => ({ own: [...s.own.filter((x) => x !== batchId), batchId].slice(-MAX) })),
  record: (b) => set((s) => ({ done: [...s.done.filter((x) => x.batchId !== b.batchId), { ...b, at: Date.now() }].slice(-MAX), undone: s.undone.filter((x) => x.projectId !== b.projectId) })),
  markUndone: (batchId) =>
    set((s) => {
      const b = s.done.find((x) => x.batchId === batchId);
      return { done: s.done.filter((x) => x.batchId !== batchId), undone: b ? [...s.undone, b].slice(-MAX) : s.undone };
    }),
  markRedone: (batchId) =>
    set((s) => {
      const b = s.undone.find((x) => x.batchId === batchId);
      return { undone: s.undone.filter((x) => x.batchId !== batchId), done: b ? [...s.done, b].slice(-MAX) : s.done };
    }),
  clear: (projectId) => set((s) => (projectId ? { done: s.done.filter((x) => x.projectId !== projectId), undone: s.undone.filter((x) => x.projectId !== projectId) } : { done: [], undone: [] })),
}));

/** The batch ⌘Z would undo in this project, as far as this tab knows. */
export const lastDone = (projectId: string): TabBatch | undefined => [...useTabUndo.getState().done].reverse().find((b) => b.projectId === projectId);
export const lastUndone = (projectId: string): TabBatch | undefined => [...useTabUndo.getState().undone].reverse().find((b) => b.projectId === projectId);

/** "Moved 3 items to MRI" → "Undo move of 3 items to MRI"-ish hint text for menus. */
export function undoHint(label: string | undefined | null): string {
  if (!label) return "Undo";
  return `Undo: ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}
export function redoHint(label: string | undefined | null): string {
  if (!label) return "Redo";
  return `Redo: ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** Hook: the tab's undo / redo labels for a project. */
export function useTabUndoLabels(projectId: string): { undo: TabBatch | undefined; redo: TabBatch | undefined } {
  const undo = useTabUndo((s) => [...s.done].reverse().find((b) => b.projectId === projectId));
  const redo = useTabUndo((s) => [...s.undone].reverse().find((b) => b.projectId === projectId));
  return { undo, redo };
}
