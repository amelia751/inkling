import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { Annotation } from "@studio/plugin-contracts";
import type { InspectContext } from "./module";
import type { EnvError, ResolvedCommand, ResolvedEnv, ResolveResult } from "./resolved";

/**
 * The host API (todo/done/todo2.md §1.6): everything a plugin's UI may ask of the Studio. A
 * plugin never imports `apps/web` internals; it calls `useHost(selector)` for state and
 * actions, `useHost.getState()` / `useHost.subscribe()` outside React, and the functions
 * below for commands, geometry descriptions, environment resolution and asset URLs.
 *
 * The extension host binds the real implementation once at boot (`bindHost`, in
 * apps/web/src/extension-host/host.tsx, backed by the Studio's Zustand store). Tests bind
 * or provide a fake one (`<HostProvider host={…}>`), so plugins depend only on this SDK.
 */

/** A tool's local name (`select`, `box`, `brush`…), as declared by its tool contribution. */
export type ToolId = string;
/** @deprecated Use ToolId. */
export type Tool = ToolId;

export type SaveState = "idle" | "saving" | "saved" | "error";

/** Per-tool options, keyed by tool name, defaulted from each tool's `optionsSchema`. */
export type ToolOptions = Record<ToolId, Record<string, unknown>>;

/** Studio state and actions visible to plugins. The shell's store implements exactly this. */
export interface StudioHostState {
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

export type HostListener = (state: StudioHostState, prev: StudioHostState) => void;

/** The store half of the host: a Zustand-compatible read/subscribe API. */
export interface HostStore {
  getState: () => StudioHostState;
  subscribe: (listener: HostListener) => () => void;
}

// ---- Commands -----------------------------------------------------------------------

/** Keyboard priority: renderers bind at VIEWER_PRIORITY, the shell below them. */
export const VIEWER_PRIORITY = 0;
export const SHELL_PRIORITY = -10;

export type KeyHandler = (e: KeyboardEvent) => boolean | void;
export type CommandHandler = (e?: KeyboardEvent, args?: unknown) => boolean | void;
export type CommandHandlers = Record<string, (e: KeyboardEvent) => boolean | void>;
export interface UseCommandsOptions {
  priority?: number;
  enabled?: boolean;
  /** Module id(s) bare command names resolve against. */
  scope?: string | string[];
}
export type CommandDef = ResolvedCommand | (Omit<ResolvedCommand, "keys"> & { keys: string[] });

export interface StudioHost {
  store: HostStore;
  /** URL for an asset path in the current project (seed file today; kernel signed URL later). */
  assetUrl: (path: string) => string;
  useCommands: (map: CommandHandlers, opts?: UseCommandsOptions) => void;
  useHotkeys: (handler: KeyHandler, priority?: number, enabled?: boolean) => void;
  execute: (id: string, args?: unknown) => boolean;
  registerCommand: (id: string, handler: CommandHandler) => () => void;
  commandDef: (id: string) => CommandDef | undefined;
  commandId: (name: string, scope?: string | string[]) => string;
  describeGeometry: (a: Annotation, env?: ResolvedEnv | null) => string;
  inspectRows: (a: Annotation, env: ResolvedEnv, ctx: Omit<InspectContext, "env">) => [string, string][];
  /** Resolve an environment spec against the active plugins. */
  resolveSpec: (spec: unknown) => ResolveResult;
}

let bound: StudioHost | null = null;

/** Install the host implementation (the extension host does this once at boot). */
export function bindHost(h: StudioHost): void {
  bound = h;
}

/** The bound host; throws if none is (a plugin used outside a Studio). */
export function host(): StudioHost {
  if (!bound) throw new Error("No Studio host is bound: plugins run inside a Studio (or a test that calls bindHost)");
  return bound;
}

const HostContext = createContext<StudioHost | null>(null);

/** Provide a host to a React subtree (tests render plugins inside a fake one). */
export function HostProvider({ host: value, children }: { host: StudioHost; children?: ReactNode }) {
  return createElement(HostContext.Provider, { value }, children);
}

function useCurrentHost(): StudioHost {
  return useContext(HostContext) ?? host();
}

type UseHost = {
  <T>(selector: (s: StudioHostState) => T): T;
  (): StudioHostState;
  getState: () => StudioHostState;
  subscribe: (listener: HostListener) => () => void;
};

const identity = (s: StudioHostState) => s;

/** Select Studio state (same shape and semantics as a Zustand hook: keep selectors stable). */
export const useHost: UseHost = Object.assign(
  function useHost<T>(selector: (s: StudioHostState) => T = identity as (s: StudioHostState) => T): T {
    const h = useCurrentHost();
    const get = () => selector(h.store.getState());
    return useSyncExternalStore(h.store.subscribe, get, get);
  },
  {
    getState: () => host().store.getState(),
    subscribe: (listener: HostListener) => host().store.subscribe(listener),
  },
) as UseHost;

export const assetUrl = (path: string) => host().assetUrl(path);

export const useCommands = (map: CommandHandlers, opts?: UseCommandsOptions) => useCurrentHost().useCommands(map, opts);
export const useHotkeys = (handler: KeyHandler, priority?: number, enabled?: boolean) => useCurrentHost().useHotkeys(handler, priority, enabled);
export const execute = (id: string, args?: unknown) => host().execute(id, args);
export const registerCommand = (id: string, handler: CommandHandler) => host().registerCommand(id, handler);
export const commandDef = (id: string) => host().commandDef(id);
export const commandId = (name: string, scope?: string | string[]) => host().commandId(name, scope);
export const describeGeometry = (a: Annotation, env?: ResolvedEnv | null) => host().describeGeometry(a, env);
export const inspectRows = (a: Annotation, env: ResolvedEnv, ctx: Omit<InspectContext, "env">) => host().inspectRows(a, env, ctx);
/** Resolve a spec (e.g. a project's environment when an exporter runs outside the Studio). */
export const resolveSpec = (spec: unknown): ResolveResult => host().resolveSpec(spec);
export type { EnvError };

// ---- Annotation helpers (pure) ------------------------------------------------------

export const LOCAL_AUTHOR = "local-expert";

/** One option of one tool (falls back when the env doesn't declare it). */
export function toolOption<T>(s: Pick<StudioHostState, "toolOptions">, tool: ToolId, key: string, fallback: T): T {
  return (s.toolOptions[tool]?.[key] as T | undefined) ?? fallback;
}

/** React binding for one tool option. */
export function useToolOption<T>(tool: ToolId, key: string, fallback: T): T {
  return useHost((s) => toolOption(s, tool, key, fallback));
}

/**
 * Brush / eraser diameter in screen pixels for whichever sized tool is active (viewers
 * convert to their own units). Each sized tool keeps its own size.
 */
export function brushSizeOf(s: Pick<StudioHostState, "toolOptions" | "tool">): number {
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
