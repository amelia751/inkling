import { create } from "zustand";
import { type StudioHostState, type ToolId, type ToolOptions } from "@studio/plugin-ui-sdk/host";
import { labelNames } from "@studio/contracts/environment";
import type { ResolvedEnv } from "@/extension-host/resolve";
import type { Annotation } from "@studio/contracts/types";

export type { SaveState, Tool, ToolId, ToolOptions } from "@studio/plugin-ui-sdk/host";
export { brushSizeOf, isEditable, LOCAL_AUTHOR, newAnnotation, toolOption, useToolOption, visibleFor } from "@studio/plugin-ui-sdk/host";

/** The Studio store implements the plugin host's state contract exactly (packages/plugin-ui-sdk/src/host.ts). */
export type StudioState = StudioHostState;

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
