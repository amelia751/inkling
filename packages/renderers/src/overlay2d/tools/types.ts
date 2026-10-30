import type { Annotation, Geometry, Pt } from "@studio/contracts/types";
import type { HandleRef } from "../edit";
import type { Region } from "../regions";
import type { Entry, Scene } from "../scene";
import type { Transform2D } from "../transform";
import type { StudioHostState } from "@studio/plugin-ui-sdk";

/**
 * Tool state machines (todo phase 4, kits/overlay2d/tools). Each drawing tool is a small
 * object fed pointer input in image and screen coordinates; it keeps its own draft and
 * writes annotations through the context. The engine routes events, owns the pointer and
 * draws `draft()` on the edit layer, so tools never touch the DOM or a canvas and can be
 * unit-tested with a fake transform.
 */

/** In-progress state a tool exposes for drawing (and for hit-tests while editing). */
export type Draft =
  | { kind: "shape"; tool: "box" | "ellipse"; a: Pt; b: Pt; square: boolean }
  | { kind: "path"; tool: "polygon" | "polyline" | "freehand"; points: Pt[]; pressing: boolean; lastScreen: Pt }
  | { kind: "length"; a: Pt; b: Pt }
  | { kind: "brush"; erase: boolean; points: Pt[]; radius: number; addTo: string | null; lastScreen: Pt }
  | {
      kind: "edit";
      id: string;
      base: Geometry;
      geometry: Geometry;
      mode: "move" | "handle";
      handle?: HandleRef;
      start: Pt;
      startScreen: Pt;
      moved: boolean;
      /** Click (no drag) on an edge inserts a vertex here. */
      insert?: { ring: number; index: number; p: Pt };
      /** Moving a multi-selection: every editable selected object and its moved geometry. */
      group?: { id: string; base: Geometry; geometry: Geometry }[];
      /** A click (no drag) on a member of a multi-selection selects just that object. */
      clickSelect?: string;
    }
  /** Shift-drag rectangle or Alt-drag lasso on empty canvas (select tool), screen px. */
  | { kind: "area"; mode: "rect" | "lasso"; points: Pt[]; additive: boolean };

export interface PointerInput {
  /** Stage CSS px. */
  screen: Pt;
  /** Image (item) px. */
  p: Pt;
  shift: boolean;
  alt: boolean;
  /** Second press within the double-click window at the same spot. */
  dbl: boolean;
}

/**
 * What a press did: `claim` owns the pointer until release (move/up are routed to the
 * tool), `consume` swallows the press without owning it (a click tool), `pass` leaves it
 * to the host (pan).
 */
export type DownResult = "claim" | "consume" | "pass";

/** Length / area formatting and physical units for readouts, measurements and the scale bar. */
export interface Units {
  formatLength(px: number): string;
  formatArea(px2: number): string;
  /** Stats stored on a length measurement (`length_px`, `length_um`…). */
  lengthStats(px: number): Record<string, number>;
  /** Unit recorded on length measurements. */
  unit: string;
  /** Scale bar: physical units per image px and the nice lengths to choose from. Absent: no bar. */
  scaleBar?: { perPx: number; steps: number[]; format(n: number): string };
}

export const PIXEL_UNITS: Units = {
  formatLength: (px) => `${Math.round(px).toLocaleString()} px`,
  formatArea: (px2) => `${Math.round(px2).toLocaleString()} px²`,
  lengthStats: (px) => ({ length_px: Math.round(px * 10) / 10 }),
  unit: "px",
};

export type RegionOp = "add" | "subtract";

/** What tools may read and do. Implemented by OverlayEngine (and by fakes in tests). */
export interface ToolContext {
  readonly view: Transform2D;
  readonly scene: Scene;
  readonly itemId: string;
  readonly units: Units;
  store(): StudioHostState;
  editable(a: Annotation): boolean;
  /** The primary selection's scene entry. */
  selected(): Entry | undefined;
  /** Add an annotation with the active label (placement stamped on); selects it by default. */
  create(geometry: Geometry, select?: boolean): Annotation | null;
  /** Merge a painted region into the store (see tools/regionOps.ts). */
  applyRegion(region: Region, op: RegionOp, target: string | null): void;
  /** A quick click on empty canvas with the select tool clears the selection (host decides what "quick" is). */
  deselectOnClick(screen: Pt): void;
  /** Long-running tools (wand) show a busy hint and refuse new presses meanwhile. */
  setBusy(busy: boolean): void;
  readonly busy: boolean;
}

export interface ToolMachine {
  /** Needs an active label to start (drawing tools); select and navigation tools don't. */
  readonly needsLabel: boolean;
  /** Stage cursor while the tool is active. */
  readonly cursor: string;
  down(e: PointerInput, ctx: ToolContext): DownResult;
  /** Pointer moves while this tool owns the pointer. */
  move?(e: PointerInput, ctx: ToolContext): void;
  up?(e: PointerInput, ctx: ToolContext): void;
  /** Pointer capture was lost (pointercancel). Default: cancel. */
  lost?(ctx: ToolContext): void;
  /** Esc / tool switch: drop the draft. */
  cancel(): void;
  /** Enter: finish the draft. False when there's nothing to finish. */
  finish?(ctx: ToolContext): boolean;
  /** Backspace while drafting: drop the last vertex. False to fall through. */
  removeLast?(ctx: ToolContext): boolean;
  draft(): Draft | null;
  /** Status hint while drafting ("4 points · …"). */
  hint?(): string | null;
  /** Brush-style hover ring, screen-px radius. */
  ring?(ctx: ToolContext): { radius: number; erase: boolean } | null;
}

export const r1 = (n: number) => Math.round(n * 10) / 10;
export const r1pts = (q: Pt[]) => q.map(([x, y]) => [r1(x), r1(y)] as Pt);
export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
