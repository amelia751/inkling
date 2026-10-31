import { useEffect, useRef } from "react";
import type React from "react";
import { create } from "zustand";
import type { SourceNode } from "@studio/contracts/types";
import type { IconComponent } from "@studio/ui/icons";
import { DROP_TARGET_CLASS, SPRING_LOAD_MS, edgeAutoScroll } from "@studio/ui/drag";

export { DROP_TARGET_CLASS, SPRING_LOAD_MS, edgeAutoScroll };

/**
 * One drag controller for Files (todo7 §2 Drag and drop, Phase 3): rows dragged from the
 * listing (list and grid) or the tree onto tree folders, listing folders and breadcrumb
 * segments. Native HTML5 drag and drop with our own data type; the ghost is a chip ("3 items"
 * with the first item's icon, `+` while ⌥ copies, the reason when refused). Spring-loaded
 * targets open after 700ms; scrollers marked `data-fs-autoscroll` scroll near their edges;
 * Esc cancels (the browser ends the drag).
 *
 * Wiring:
 * - sources: spread `useFsDragSource(() => items, { source: "listing" })` on a row; the tree
 *   reports its own drags with `<FileTree onDragChange={(ids) => ids ? beginFsDrag(items(ids), "tree") : endFsDrag()}>`;
 * - targets: spread `fsDropTargetProps(folderId, label)` on listing folders and breadcrumb
 *   segments (tree folder rows already carry `data-folder-id`); highlight with
 *   `useIsFsDropTarget(id) && DROP_TARGET_CLASS`, and pass `useFsDrag((s) => s.target?.id)` to
 *   the tree's `dropTargetId`;
 * - one zone: spread `useFsDropZone({ describe, onDrop })` on the page root (it ignores OS
 *   files, which keep `fromDataTransfer` → `addData`), and mount `<FsDragGhost />` once.
 */

/** The dataTransfer type of a Files drag (no product name: it never leaves the app). */
export const FS_DRAG_TYPE = "application/x-fs-nodes";

export type FsDragSource = "tree" | "listing" | "breadcrumb";

export interface FsDragItem {
  id: string;
  name: string;
  kind: SourceNode["kind"];
  parentId: string | null;
  /** Inside sample data (D2): can be copied out, not moved. */
  locked?: boolean;
  icon?: IconComponent;
}

export interface FsDropTarget {
  id: string;
  label: string;
}

interface FsDragState {
  drag: { items: FsDragItem[]; source: FsDragSource } | null;
  /** The folder under the pointer (allowed or not). */
  target: FsDropTarget | null;
  /** Why `target` refuses the drop, or null when it accepts. */
  refusal: string | null;
  /** ⌥ held: the drop copies. */
  copy: boolean;
  /** Where to draw the ghost (null over the tree, which draws its own). */
  pointer: { x: number; y: number } | null;
}

const IDLE: FsDragState = { drag: null, target: null, refusal: null, copy: false, pointer: null };

export const useFsDrag = create<FsDragState>(() => IDLE);

/** A drag began (the tree calls this from `onDragChange`; listing rows through `useFsDragSource`). */
export function beginFsDrag(items: FsDragItem[], source: FsDragSource): void {
  useFsDrag.setState({ ...IDLE, drag: items.length ? { items, source } : null });
}

/** The drag ended (dropped, cancelled with Esc, or left the window). */
export function endFsDrag(): void {
  useFsDrag.setState(IDLE);
}

// ---- Rules ---------------------------------------------------------------------------------------

export interface DropTargetInfo {
  id: string;
  /** Ids from the root down to the target's parent (to refuse a folder into its own subfolder). */
  ancestors?: readonly string[];
  /** Sample data (D2), or inside it. */
  locked?: boolean;
  /** The Trash view (use Move to Trash instead). */
  trash?: boolean;
}

/** May `items` go into `target`? True, or the sentence for the tooltip. */
export function dropVerdict(items: readonly FsDragItem[], target: DropTargetInfo, { copy = false }: { copy?: boolean } = {}): true | string {
  if (!items.length) return "Nothing to drop";
  if (target.trash) return "To delete, use Move to Trash";
  if (items.some((i) => i.id === target.id)) return "Can't move a folder into itself";
  if (target.ancestors && items.some((i) => i.kind !== "file" && target.ancestors!.includes(i.id))) return "Can't move a folder into one of its own folders";
  if (target.locked) return "Sample data can't be changed. Copy it to make your own";
  if (!copy && items.some((i) => i.locked)) return "Sample data can't be moved. Hold ⌥ to copy it";
  if (!copy && items.every((i) => i.parentId === target.id)) return "Already in this folder";
  return true;
}

// ---- Sources -------------------------------------------------------------------------------------

let emptyImage: HTMLImageElement | null = null;
function transparentImage(): HTMLImageElement | null {
  if (typeof Image === "undefined") return null;
  if (!emptyImage) {
    emptyImage = new Image();
    emptyImage.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  }
  return emptyImage;
}

/** Start a drag from a DOM event (listing rows, tiles, breadcrumb segments). */
export function startFsDrag(e: React.DragEvent | DragEvent, items: FsDragItem[], source: FsDragSource): void {
  const dt = e.dataTransfer;
  if (!dt || !items.length) return;
  dt.effectAllowed = "copyMove";
  dt.setData(FS_DRAG_TYPE, JSON.stringify(items.map((i) => i.id)));
  const img = transparentImage();
  if (img) dt.setDragImage(img, 0, 0);
  beginFsDrag(items, source);
}

/**
 * Props for a draggable row: `draggable`, `onDragStart`, `onDragEnd`. `getItems` is read at
 * drag start (the selection when the row is in it, else the row alone).
 */
export function useFsDragSource(getItems: () => FsDragItem[], { source = "listing", disabled = false }: { source?: FsDragSource; disabled?: boolean } = {}) {
  return {
    draggable: !disabled,
    onDragStart: (e: React.DragEvent) => {
      if (disabled) return;
      e.stopPropagation();
      startFsDrag(e, getItems(), source);
    },
    onDragEnd: () => endFsDrag(),
  };
}

// ---- Targets -------------------------------------------------------------------------------------

/** Attributes for a drop target outside the tree (listing folder, breadcrumb segment). `spring`: open it after 700ms of hovering. */
export function fsDropTargetProps(id: string, label: string, { spring = true }: { spring?: boolean } = {}) {
  return { "data-fs-drop-id": id, "data-fs-drop-label": label, ...(spring ? { "data-fs-spring": "" } : {}) } as Record<string, string>;
}

/** Is a Files drag over this folder now (allowed or not)? For the highlight. */
export const useIsFsDropTarget = (id: string): boolean => useFsDrag((s) => !!s.drag && s.target?.id === id);

/** The target element under an event: a `data-fs-drop-id` element, or a tree folder row (`data-folder-id`). */
export function targetOf(el: EventTarget | null): (FsDropTarget & { spring: boolean; inTree: boolean }) | null {
  if (!(el instanceof Element)) return null;
  const outside = el.closest<HTMLElement>("[data-fs-drop-id]");
  if (outside?.dataset.fsDropId) return { id: outside.dataset.fsDropId, label: outside.dataset.fsDropLabel ?? "this folder", spring: outside.hasAttribute("data-fs-spring"), inTree: false };
  const row = el.closest<HTMLElement>("[data-folder-id]");
  if (row?.dataset.folderId) return { id: row.dataset.folderId, label: row.getAttribute("title") ?? row.textContent?.trim() ?? "this folder", spring: false, inTree: true };
  return null;
}

export interface FsDropZoneOptions {
  /** What the zone knows about a folder (ancestors, locked, trash) for the built-in rules. */
  describe?: (folderId: string) => Omit<DropTargetInfo, "id"> | undefined;
  /** Extra rules (e.g. a name conflict needing a decision returns true: the dialog opens on drop). */
  canDrop?: (items: FsDragItem[], target: FsDropTarget, copy: boolean) => true | string;
  onDrop: (args: { items: FsDragItem[]; target: FsDropTarget; copy: boolean }) => void;
  /** A spring-loaded target (listing folder, breadcrumb segment) was hovered for 700ms: open it. */
  onSpringOpen?: (folderId: string) => void;
}

/**
 * Handlers for the one element that contains every target (the page root). Drags that aren't
 * ours (OS files) pass through untouched; a tree drag over the tree is left to the tree.
 */
export function useFsDropZone(opts: FsDropZoneOptions) {
  const ref = useRef(opts);
  ref.current = opts;
  const spring = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => () => {
    if (spring.current) clearTimeout(spring.current.timer);
  }, []);

  const verdictFor = (items: FsDragItem[], target: FsDropTarget, copy: boolean): true | string => {
    const info = ref.current.describe?.(target.id);
    const base = dropVerdict(items, { id: target.id, ...info }, { copy });
    if (base !== true) return base;
    return ref.current.canDrop?.(items, target, copy) ?? true;
  };

  const armSpring = (t: ReturnType<typeof targetOf>) => {
    if (spring.current?.id === t?.id) return;
    if (spring.current) clearTimeout(spring.current.timer);
    spring.current = null;
    if (!t?.spring || !ref.current.onSpringOpen) return;
    const id = t.id;
    spring.current = { id, timer: setTimeout(() => ref.current.onSpringOpen?.(id), SPRING_LOAD_MS) };
  };

  const over = (e: React.DragEvent) => {
    const { drag } = useFsDrag.getState();
    if (!drag) return;
    const t = targetOf(e.target);
    if (drag.source === "tree" && (t?.inTree || (e.target instanceof Element && e.target.closest("[data-file-tree]")))) {
      // The tree handles drags inside itself (and draws its own ghost).
      if (useFsDrag.getState().pointer) useFsDrag.setState({ pointer: null, target: null, refusal: null });
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const scroller = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-fs-autoscroll]") : null;
    if (scroller) edgeAutoScroll(scroller, e.clientX, e.clientY);
    const copy = e.altKey;
    const verdict = t ? verdictFor(drag.items, t, copy) : "Drop on a folder";
    if (e.dataTransfer) e.dataTransfer.dropEffect = verdict === true ? (copy ? "copy" : "move") : "none";
    armSpring(t);
    const s = useFsDrag.getState();
    const target = t ? { id: t.id, label: t.label } : null;
    const refusal = t && verdict !== true ? verdict : null;
    if (s.target?.id !== target?.id || s.refusal !== refusal || s.copy !== copy || s.pointer?.x !== e.clientX || s.pointer?.y !== e.clientY) {
      useFsDrag.setState({ target, refusal, copy, pointer: { x: e.clientX, y: e.clientY } });
    }
  };

  return {
    onDragEnter: over,
    onDragOver: over,
    onDragLeave: (e: React.DragEvent) => {
      if (!useFsDrag.getState().drag) return;
      const next = e.relatedTarget;
      if (next instanceof Node && (e.currentTarget as Node).contains(next)) return;
      armSpring(null);
      useFsDrag.setState({ target: null, refusal: null, pointer: null });
    },
    onDrop: (e: React.DragEvent) => {
      const { drag } = useFsDrag.getState();
      if (!drag) return;
      const t = targetOf(e.target);
      if (drag.source === "tree" && t?.inTree) return;
      e.preventDefault();
      e.stopPropagation();
      armSpring(null);
      const copy = e.altKey;
      endFsDrag();
      if (t && verdictFor(drag.items, t, copy) === true) ref.current.onDrop({ items: drag.items, target: { id: t.id, label: t.label }, copy });
    },
  };
}
