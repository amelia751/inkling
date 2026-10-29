import { create } from "zustand";
import { labelNames } from "@/platform/environment";
import type { ResolvedEnv } from "@/platform/resolve";
import type { Annotation } from "@/types";

/**
 * A tool's local name (`select`, `box`, `brush`…), as declared by its tool contribution.
 * The registry is the source of truth for which tools exist; the resolved environment
 * guarantees names are unique within a Studio, so renderers can switch on them.
 */
export type ToolId = string;
/** @deprecated Use ToolId. */
export type Tool = ToolId;

export type SaveState = "idle" | "saving" | "saved" | "error";

/** Per-tool options, keyed by tool name, defaulted from each tool's `optionsSchema`. */
export type ToolOptions = Record<ToolId, Record<string, unknown>>;

export interface StudioState {
  projectId: string | null;
  itemIndex: number;
  tool: ToolId;
  toolOptions: ToolOptions;
  /** Draw filled regions and masks as outlines only. */
  outlineOnly: boolean;
  /** The resolved environment the Studio is running. Agent edits go through `setEnv`. */
  env: ResolvedEnv | null;
  /** Environment history, separate from annotation undo so agent edits are undoable on their own. */
  envPast: ResolvedEnv[];
  envFuture: ResolvedEnv[];
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
  setTool: (t: ToolId) => void;
  setToolOption: (tool: ToolId, key: string, value: unknown) => void;
  setOutlineOnly: (on: boolean) => void;
  /** Install a resolved environment. `record: false` replaces without an undo step (first load). */
  setEnv: (env: ResolvedEnv, opts?: { record?: boolean }) => void;
  undoEnv: () => void;
  redoEnv: () => void;
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
  /**
   * Set an item-level class. Single-valued groups (Label Studio `Choices`) replace the
   * item's other classes from the same group; `multiple` groups toggle the class.
   * Without `group`, every class annotation not owned by a multiple group is replaced.
   */
  setClass: (itemId: string, label: string, author: string, opts?: { group?: string }) => void;
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
    toolOptions: {},
    outlineOnly: false,
    env: null,
    envPast: [],
    envFuture: [],
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
    setToolOption: (tool, key, value) => set((s) => ({ toolOptions: { ...s.toolOptions, [tool]: { ...s.toolOptions[tool], [key]: value } } })),
    setOutlineOnly: (outlineOnly) => set({ outlineOnly }),
    setEnv: (env, { record = true } = {}) =>
      set((s) => ({
        env,
        toolOptions: defaultToolOptions(env, s.toolOptions),
        envPast: record && s.env ? [...s.envPast, s.env].slice(-HISTORY_LIMIT) : s.envPast,
        envFuture: record ? [] : s.envFuture,
      })),
    undoEnv: () => {
      const { envPast, env, envFuture } = get();
      if (!envPast.length || !env) return;
      const prev = envPast[envPast.length - 1];
      set((s) => ({ env: prev, envPast: envPast.slice(0, -1), envFuture: [env, ...envFuture], toolOptions: defaultToolOptions(prev, s.toolOptions) }));
    },
    redoEnv: () => {
      const { envPast, env, envFuture } = get();
      if (!envFuture.length || !env) return;
      set((s) => ({ env: envFuture[0], envFuture: envFuture.slice(1), envPast: [...envPast, env], toolOptions: defaultToolOptions(envFuture[0], s.toolOptions) }));
    },
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
    setClass: (itemId, label, author, { group } = {}) => {
      const groups = (get().env?.labels ?? []).filter((g) => g.control === "Choices");
      const target = groups.find((g) => g.name === group) ?? groups.find((g) => g.classes.some((c) => c.id === label));
      const multiple = new Set(groups.filter((g) => g.multiple).flatMap((g) => g.classes.map((c) => c.id)));
      const isClass = (a: Annotation) => a.itemId === itemId && a.geometry.type === "class";
      const list = get().annotations;
      if (target?.multiple) {
        // Multi-valued group: toggle this class, keep everything else.
        const existing = list.find((a) => isClass(a) && a.label === label);
        if (existing) return commit(list.filter((a) => a !== existing));
        return commit([...list, classAnnotation(itemId, label, author)]);
      }
      // Single-valued: replace this group's class. With no Choices group for the label, replace
      // classes of the environment's own vocabulary; record-level statements outside it stay.
      const replace = new Set(target ? target.classes.map((c) => c.id) : [...labelNames(get().env?.labels), label].filter((l) => !multiple.has(l)));
      const rest = list.filter((a) => !(isClass(a) && replace.has(a.label)));
      commit([...rest, classAnnotation(itemId, label, author)]);
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

const classAnnotation = (itemId: string, label: string, author: string): Annotation => ({
  id: crypto.randomUUID(),
  itemId,
  label,
  geometry: { type: "class" },
  provenance: "human-created",
  author,
  createdAt: new Date().toISOString(),
});

/** Keep options the user already set; fill in each env tool's schema defaults. */
function defaultToolOptions(env: ResolvedEnv, current: ToolOptions): ToolOptions {
  const out: ToolOptions = { ...current };
  for (const t of env.tools) {
    if (!t.optionsSchema) continue;
    const parsed = t.optionsSchema.safeParse(current[t.name] ?? {});
    out[t.name] = parsed.success ? (parsed.data as Record<string, unknown>) : (t.optionsSchema.parse({}) as Record<string, unknown>);
  }
  return out;
}

/** One option of one tool (falls back when the env doesn't declare it). */
export function toolOption<T>(s: Pick<StudioState, "toolOptions">, tool: ToolId, key: string, fallback: T): T {
  return (s.toolOptions[tool]?.[key] as T | undefined) ?? fallback;
}

/** React binding for one tool option. */
export function useToolOption<T>(tool: ToolId, key: string, fallback: T): T {
  return useStudio((s) => toolOption(s, tool, key, fallback));
}

/**
 * Brush / eraser diameter in screen pixels for whichever sized tool is active (viewers
 * convert to their own units). Each sized tool keeps its own size.
 */
export function brushSizeOf(s: Pick<StudioState, "toolOptions" | "tool">): number {
  const own = s.toolOptions[s.tool]?.size;
  return typeof own === "number" ? own : toolOption(s, "brush", "size", 16);
}

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
