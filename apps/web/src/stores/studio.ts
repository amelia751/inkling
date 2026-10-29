import { create } from "zustand";
import type { Annotation } from "@/types";

export type Tool = "select" | "pan" | "box" | "point" | "interval" | "polygon" | "mark" | "segment";
export type SaveState = "idle" | "saving" | "saved" | "error";

interface StudioState {
  projectId: string | null;
  itemIndex: number;
  tool: Tool;
  activeLabel: string | null;
  annotations: Annotation[];
  /** Server revision the current annotations were last confirmed at. */
  revision: number;
  dirty: boolean;
  saveState: SaveState;
  past: Annotation[][];
  future: Annotation[][];
  aiOpen: boolean;
  /** Free-form viewer status shown in the bottom bar (slice, zoom, time window…). */
  viewerStatus: string;

  load: (projectId: string, annotations: Annotation[], revision: number, firstLabel: string | null) => void;
  setItemIndex: (i: number) => void;
  setTool: (t: Tool) => void;
  setActiveLabel: (l: string) => void;
  add: (a: Annotation) => void;
  remove: (id: string) => void;
  /** Replace the item's class annotation (classification tasks hold one label per item). */
  setClass: (itemId: string, label: string, author: string) => void;
  undo: () => void;
  redo: () => void;
  markSaving: () => void;
  markSaved: (revision: number, snapshot: Annotation[]) => void;
  markError: () => void;
  toggleAi: () => void;
  setViewerStatus: (s: string) => void;
}

const HISTORY_LIMIT = 100;

export const useStudio = create<StudioState>((set, get) => {
  const commit = (next: Annotation[]) =>
    set((s) => ({
      annotations: next,
      past: [...s.past, s.annotations].slice(-HISTORY_LIMIT),
      future: [],
      dirty: true,
    }));

  return {
    projectId: null,
    itemIndex: 0,
    tool: "select",
    activeLabel: null,
    annotations: [],
    revision: 0,
    dirty: false,
    saveState: "idle",
    past: [],
    future: [],
    aiOpen: false,
    viewerStatus: "",

    load: (projectId, annotations, revision, firstLabel) =>
      set({
        projectId,
        annotations,
        revision,
        activeLabel: firstLabel,
        itemIndex: 0,
        tool: "select",
        past: [],
        future: [],
        dirty: false,
        saveState: revision > 0 ? "saved" : "idle",
      }),
    setItemIndex: (itemIndex) => set({ itemIndex }),
    setTool: (tool) => set({ tool }),
    setActiveLabel: (activeLabel) => set({ activeLabel }),
    add: (a) => commit([...get().annotations, a]),
    remove: (id) => commit(get().annotations.filter((a) => a.id !== id)),
    setClass: (itemId, label, author) => {
      const rest = get().annotations.filter((a) => !(a.itemId === itemId && a.geometry.type === "class"));
      commit([
        ...rest,
        {
          id: crypto.randomUUID(),
          itemId,
          label,
          geometry: { type: "class" },
          provenance: "human-created",
          author,
          createdAt: new Date().toISOString(),
        },
      ]);
    },
    undo: () => {
      const { past, annotations, future } = get();
      if (!past.length) return;
      set({ annotations: past[past.length - 1], past: past.slice(0, -1), future: [annotations, ...future], dirty: true });
    },
    redo: () => {
      const { past, annotations, future } = get();
      if (!future.length) return;
      set({ annotations: future[0], future: future.slice(1), past: [...past, annotations], dirty: true });
    },
    markSaving: () => set({ saveState: "saving" }),
    // Only clear `dirty` if nothing changed while the request was in flight.
    markSaved: (revision, snapshot) =>
      set((s) => ({ revision, saveState: "saved", dirty: s.annotations !== snapshot })),
    markError: () => set({ saveState: "error" }),
    toggleAi: () => set((s) => ({ aiOpen: !s.aiOpen })),
    setViewerStatus: (viewerStatus) => set({ viewerStatus }),
  };
});

export const LOCAL_AUTHOR = "local-expert";

export function newAnnotation(fields: Omit<Annotation, "id" | "createdAt" | "provenance" | "author">): Annotation {
  return {
    ...fields,
    id: crypto.randomUUID(),
    provenance: "human-created",
    author: LOCAL_AUTHOR,
    createdAt: new Date().toISOString(),
  };
}
