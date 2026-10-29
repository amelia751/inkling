import { create } from "zustand";
import type { Annotation } from "@/types";

export type Tool =
  // navigation
  | "select"
  | "pan"
  | "zoom"
  | "windowLevel"
  | "crosshairs"
  // 2D shapes
  | "box"
  | "ellipse"
  | "polygon"
  | "freehand"
  | "polyline"
  | "spline"
  | "keypoint"
  | "point"
  | "mark"
  // measurements
  | "length"
  | "angle"
  | "cobb"
  | "bidirectional"
  | "probe"
  | "arrow"
  // masks
  | "brush"
  | "eraser"
  | "wand"
  // time
  | "interval"
  | "beat"
  | "wave"
  | "rhythm"
  | "caliper"
  | "segment"
  | "event";

export type SaveState = "idle" | "saving" | "saved" | "error";

export interface ToolOptions {
  /** Brush / eraser diameter in screen pixels (viewers convert to their own units). */
  brushSize: number;
  /** Restrict brush strokes to intensities inside the current window (threshold brush). */
  brushThreshold: boolean;
  /** Draw filled regions as outlines only. */
  outlineOnly: boolean;
}

interface StudioState {
  projectId: string | null;
  itemIndex: number;
  tool: Tool;
  toolOptions: ToolOptions;
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
  /** Primary selection: the most recently selected annotation (inspector, handles). */
  selectedId: string | null;
  /** Every selected annotation, primary included. Shift/⌘-click adds; bulk actions apply to all. */
  selectedIds: string[];
  /** Labels whose annotations are hidden / locked in every viewer. */
  hiddenLabels: string[];
  lockedLabels: string[];
  /** Fill opacity multiplier for overlays and masks, 0–1. */
  overlayOpacity: number;

  load: (projectId: string, annotations: Annotation[], revision: number, firstLabel: string | null) => void;
  setItemIndex: (i: number) => void;
  setTool: (t: Tool) => void;
  setToolOptions: (o: Partial<ToolOptions>) => void;
  setActiveLabel: (l: string) => void;
  add: (a: Annotation) => void;
  /** Add several annotations as one undo step. */
  addMany: (a: Annotation[]) => void;
  /** Patch one annotation (geometry, label, attributes…); marks AI suggestions as human-corrected. */
  update: (id: string, patch: Partial<Omit<Annotation, "id" | "itemId">>) => void;
  /** Insert or replace by id as one undo step (masks streamed from a renderer). */
  upsert: (a: Annotation) => void;
  /** Patch, insert-or-replace and remove several annotations as ONE undo step (eraser strokes, ED+ES apply, re-detection). */
  batch: (ops: { update?: { id: string; patch: Partial<Omit<Annotation, "id" | "itemId">> }[]; upsert?: Annotation[]; remove?: string[] }) => void;
  remove: (id: string) => void;
  removeMany: (ids: string[]) => void;
  /** Replace the item's class annotation (classification tasks hold one label per item). */
  setClass: (itemId: string, label: string, author: string) => void;
  /** Replace the selection with one annotation (or clear it). */
  select: (id: string | null) => void;
  /** Add or remove one annotation from the selection (Shift/⌘-click). */
  toggleSelect: (id: string) => void;
  /** Replace the selection with several annotations (lasso, select all). */
  selectMany: (ids: string[]) => void;
  toggleLabelHidden: (label: string) => void;
  toggleLabelLocked: (label: string) => void;
  setOverlayOpacity: (o: number) => void;
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
  /** Drop removed annotations from the selection. */
  const prune = (drop: Set<string>) =>
    set((s) => {
      const selectedIds = s.selectedIds.filter((x) => !drop.has(x));
      return { selectedIds, selectedId: s.selectedId && !drop.has(s.selectedId) ? s.selectedId : (selectedIds[selectedIds.length - 1] ?? null) };
    });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return {
    projectId: null,
    itemIndex: 0,
    tool: "select",
    toolOptions: { brushSize: 16, brushThreshold: false, outlineOnly: false },
    activeLabel: null,
    annotations: [],
    revision: 0,
    dirty: false,
    saveState: "idle",
    past: [],
    future: [],
    aiOpen: false,
    viewerStatus: "",
    selectedId: null,
    selectedIds: [],
    hiddenLabels: [],
    lockedLabels: [],
    overlayOpacity: 1,

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
        selectedId: null,
        selectedIds: [],
        hiddenLabels: [],
        lockedLabels: [],
      }),
    setItemIndex: (itemIndex) => set({ itemIndex, selectedId: null, selectedIds: [] }),
    setTool: (tool) => set({ tool }),
    setToolOptions: (o) => set((s) => ({ toolOptions: { ...s.toolOptions, ...o } })),
    setActiveLabel: (activeLabel) => set({ activeLabel }),
    add: (a) => commit([...get().annotations, a]),
    addMany: (list) => list.length && commit([...get().annotations, ...list]),
    update: (id, patch) =>
      commit(
        get().annotations.map((a) =>
          a.id === id
            ? {
                ...a,
                ...patch,
                provenance: patch.provenance ?? (a.provenance === "ai-suggested" && (patch.geometry || patch.label) ? "human-corrected" : a.provenance),
                updatedAt: new Date().toISOString(),
              }
            : a,
        ),
      ),
    batch: ({ update = [], upsert = [], remove = [] }) => {
      if (!update.length && !upsert.length && !remove.length) return;
      const drop = new Set(remove);
      const patches = new Map(update.map((u) => [u.id, u.patch]));
      const replace = new Map(upsert.map((a) => [a.id, a]));
      const now = new Date().toISOString();
      const next = get()
        .annotations.filter((a) => !drop.has(a.id))
        .map((a) => {
          if (replace.has(a.id)) {
            const r = replace.get(a.id)!;
            replace.delete(a.id);
            return r;
          }
          const patch = patches.get(a.id);
          if (!patch) return a;
          const corrected = a.provenance === "ai-suggested" && (patch.geometry || patch.label) ? "human-corrected" : a.provenance;
          return { ...a, ...patch, provenance: patch.provenance ?? corrected, updatedAt: now };
        });
      commit([...next, ...replace.values()]);
      prune(drop);
    },
    upsert: (a) => {
      const list = get().annotations;
      commit(list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a]);
    },
    remove: (id) => {
      commit(get().annotations.filter((a) => a.id !== id));
      prune(new Set([id]));
    },
    removeMany: (ids) => {
      const drop = new Set(ids);
      commit(get().annotations.filter((a) => !drop.has(a.id)));
      prune(drop);
    },
    setClass: (itemId, label, author) => {
      // Record-level statements (e.g. ECG SNOMED codes) are also `class` annotations but multi-valued; keep them.
      const rest = get().annotations.filter((a) => !(a.itemId === itemId && a.geometry.type === "class" && a.attributes?.snomed === undefined));
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
    select: (selectedId) => set({ selectedId, selectedIds: selectedId ? [selectedId] : [] }),
    toggleSelect: (id) =>
      set((s) => {
        const selectedIds = s.selectedIds.includes(id) ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id];
        return { selectedIds, selectedId: selectedIds.includes(id) ? id : (selectedIds[selectedIds.length - 1] ?? null) };
      }),
    selectMany: (ids) => set({ selectedIds: ids, selectedId: ids[ids.length - 1] ?? null }),
    toggleLabelHidden: (label) => set((s) => ({ hiddenLabels: toggle(s.hiddenLabels, label) })),
    toggleLabelLocked: (label) => set((s) => ({ lockedLabels: toggle(s.lockedLabels, label) })),
    setOverlayOpacity: (overlayOpacity) => set({ overlayOpacity }),
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

export function newAnnotation(
  fields: Omit<Annotation, "id" | "createdAt" | "provenance" | "author"> & Partial<Pick<Annotation, "provenance" | "author">>,
): Annotation {
  return {
    provenance: "human-created",
    author: LOCAL_AUTHOR,
    ...fields,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

/** Annotations of one item the expert can currently see (label and per-annotation visibility applied). */
export function visibleFor(annotations: Annotation[], itemId: string, hiddenLabels: string[]): Annotation[] {
  return annotations.filter((a) => a.itemId === itemId && !a.hidden && !hiddenLabels.includes(a.label));
}

/** Whether an annotation may be edited, moved or deleted. */
export function isEditable(a: Annotation, lockedLabels: string[]): boolean {
  return !a.locked && !lockedLabels.includes(a.label);
}
