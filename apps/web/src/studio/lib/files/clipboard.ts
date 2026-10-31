import { create } from "zustand";

/**
 * The Files clipboard (todo7 Phase 3; kiwifs `lib/treeClipboard.ts`, but node ids and per tab):
 * ⌘X marks nodes as cut (drawn at 50% until pasted), ⌘C as copied (copies are free, D5), ⌘V
 * pastes into the focused or shown folder. It survives navigation inside the project and
 * clears when the project changes. Not the system clipboard: nothing leaves the tab.
 */
export type ClipboardMode = "cut" | "copy";

export interface FilesClipboard {
  projectId: string | null;
  mode: ClipboardMode | null;
  nodeIds: string[];
  /** Put nodes on the clipboard (replacing what was there). An empty list clears it. */
  set: (projectId: string, mode: ClipboardMode, nodeIds: string[]) => void;
  clear: () => void;
  /** The shown project changed: forget another project's clipboard. */
  setProject: (projectId: string | null) => void;
  /** After a paste: a cut is consumed (the nodes moved); a copy stays for pasting again. */
  pasted: () => void;
  /** Nodes no longer exist (trashed, purged): drop them. */
  forget: (nodeIds: string[]) => void;
}

const EMPTY = { projectId: null, mode: null, nodeIds: [] as string[] };

export const useFilesClipboard = create<FilesClipboard>((set, get) => ({
  ...EMPTY,
  set: (projectId, mode, nodeIds) => set(nodeIds.length ? { projectId, mode, nodeIds: [...new Set(nodeIds)] } : { ...EMPTY, projectId }),
  clear: () => set({ ...EMPTY, projectId: get().projectId }),
  setProject: (projectId) => {
    if (get().projectId !== projectId) set({ ...EMPTY, projectId });
  },
  pasted: () => {
    if (get().mode === "cut") set({ ...EMPTY, projectId: get().projectId });
  },
  forget: (nodeIds) => {
    const drop = new Set(nodeIds);
    const left = get().nodeIds.filter((id) => !drop.has(id));
    set(left.length ? { nodeIds: left } : { ...EMPTY, projectId: get().projectId });
  },
}));

/** What Paste would do in this project: `{ mode, nodeIds }`, or null when there's nothing. */
export function clipboardFor(projectId: string): { mode: ClipboardMode; nodeIds: string[] } | null {
  const c = useFilesClipboard.getState();
  return c.projectId === projectId && c.mode && c.nodeIds.length ? { mode: c.mode, nodeIds: c.nodeIds } : null;
}

/** Hook: the ids drawn at 50% (cut, not yet pasted) in this project. */
export function useCutIds(projectId: string): readonly string[] {
  return useFilesClipboard((c) => (c.projectId === projectId && c.mode === "cut" ? c.nodeIds : NONE));
}

/** Hook: "Paste (3 items)" — how many nodes Paste would bring, 0 for none. */
export function usePasteCount(projectId: string): number {
  return useFilesClipboard((c) => (c.projectId === projectId && c.mode ? c.nodeIds.length : 0));
}

const NONE: readonly string[] = [];
