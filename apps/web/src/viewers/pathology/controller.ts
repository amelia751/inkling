import { labelNames } from "@/platform/environment";
import OpenSeadragon from "openseadragon";
import { seedUrl } from "@/lib/api";
import { resolveLabelColor, resolveToken } from "@/lib/labels";
import { brushSizeOf, isEditable, newAnnotation, useStudio, visibleFor, type Tool } from "@/stores/studio";
import type { Annotation, Geometry, Project, Pt, SeedAsset, StudioItem } from "@/types";
import { drawHandles, CLOSE_RADIUS } from "@/viewers/shared/draw";
import { hitEdge, pathLength, pointInPolygon, polygonArea, simplify } from "@/viewers/shared/geometry";
import { formatArea, formatLength, lengthStats } from "./measure";
import {
  bboxOverlap,
  geometryFromRegion,
  isRegion,
  pointInRegion,
  regionArea,
  regionOf,
  regionPerimeter,
  ringsBounds,
  strokeToRegion,
  subtractRegion,
  translateGeometry,
  unionRegions,
  type BBox,
  type Region,
} from "./regions";
import { drawScene, entryFor, pathFor, lodFor, pill, Scene, type DrawStats, type Entry } from "./scene";
import { View } from "./transform";
import { lastWandRunner, NEUTRAL_ADJUST, wandRegion, type Adjustments } from "./wand";

export const PATHOLOGY_TOOLS: Tool[] = ["select", "pan", "box", "ellipse", "polygon", "freehand", "polyline", "brush", "eraser", "wand", "mark", "length"];

export interface UiState {
  ready: boolean;
  error: string | null;
  /** Current optical magnification equivalent (objective × image zoom). */
  mag: number;
  rotation: number;
  flipped: boolean;
  showNames: boolean;
  busy: boolean;
  hint: string | null;
  drawer: string;
}

type HandleRef = { kind: "ring"; ring: number; i: number } | { kind: "corner"; i: number } | { kind: "axis"; i: number };

type Draft =
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
  /** Shift-drag rectangle or Alt-drag lasso on empty slide (select tool), screen px. */
  | { kind: "area"; mode: "rect" | "lasso"; points: Pt[]; additive: boolean };

const HANDLE_RADIUS = 7;
const MAX_HANDLES = 800;
const DBL_CLICK_MS = 320;
const NICE_UM = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/** Vertex rings of an editable geometry; arrays are shared with `g` so they can be mutated in place. */
function editRings(g: Geometry): { rings: Pt[][]; closed: boolean } | null {
  switch (g.type) {
    case "polygon":
      return { rings: [g.points, ...(g.holes ?? [])], closed: true };
    case "multipolygon":
      return { rings: g.polygons.flat(), closed: true };
    case "spline":
      return { rings: [g.points], closed: true };
    case "polyline":
      return { rings: [g.points], closed: false };
    case "measurement":
      return g.space === "image" ? { rings: [g.points as Pt[]], closed: false } : null;
    default:
      return null;
  }
}

function cloneGeometry(g: Geometry): Geometry {
  return structuredClone(g);
}

/**
 * Owns the OpenSeadragon viewer, the two overlay canvases and the tool state machine.
 * Lives outside React: viewport frames redraw imperatively, and the store is read with
 * getState()/subscribe so panning never re-renders components.
 */
export class PathologyController {
  readonly viewer: OpenSeadragon.Viewer;
  readonly view = new View();
  readonly scene = new Scene();
  private imageW: number;
  private imageH: number;
  private dpr = window.devicePixelRatio || 1;
  private draft: Draft | null = null;
  private activePointer: number | null = null;
  private hover: Pt | null = null;
  private spaceHeld = false;
  private lastDown = { t: 0, x: -99, y: -99 };
  private pendingDeselect: Pt | null = null;
  private frame = 0;
  private dirtyBulk = false;
  private dirtyEdit = false;
  private unsubscribe: () => void;
  private resizeObserver: ResizeObserver;
  private ui: UiState = { ready: false, error: null, mag: 0, rotation: 0, flipped: false, showNames: false, busy: false, hint: null, drawer: "" };
  private destroyed = false;
  lastStats: DrawStats | null = null;
  adjust: Adjustments = { ...NEUTRAL_ADJUST };
  wandTolerance = 28;
  /** Where the last wand fill ran ("worker" normally; "inline" if workers are unavailable). */
  wandRunner: "worker" | "inline" | null = null;
  private readonly labels: string[];
  /** Overlay layers live inside OSD's canvas element: above the tiles, below the navigator. */
  private bulk = document.createElement("canvas");
  private edit = document.createElement("canvas");
  readonly mpp: number | null;
  readonly objective: number;

  constructor(
    private stage: HTMLDivElement,
    host: HTMLDivElement,
    private project: Project,
    private item: StudioItem,
    asset: SeedAsset,
    private onUi: (ui: UiState) => void,
  ) {
    this.labels = labelNames(project.labels);
    this.mpp = asset.mpp ?? null;
    this.objective = Number(asset.magnification) || 40;
    this.imageW = asset.width ?? 1;
    this.imageH = asset.height ?? 1;

    const navW = 220;
    this.viewer = OpenSeadragon({
      element: host,
      tileSources: seedUrl(asset.path),
      // OSD 6: WebGL where available, canvas otherwise.
      drawer: "auto",
      showNavigationControl: false,
      showNavigator: true,
      navigatorPosition: "BOTTOM_RIGHT",
      navigatorAutoFade: false,
      navigatorRotate: true,
      // Fixed size: a ratio is computed before the resizable panel has laid out.
      navigatorWidth: `${navW}px`,
      navigatorHeight: `${Math.max(60, Math.round((navW * this.imageH) / this.imageW))}px`,
      navigatorBackground: "#121215",
      navigatorBorderColor: "rgba(255,255,255,0.15)",
      navigatorDisplayRegionColor: resolveToken("--primary"),
      visibilityRatio: 0.5,
      minZoomImageRatio: 0.5,
      maxZoomPixelRatio: 2,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: false },
      gestureSettingsTouch: { pinchRotate: false },
      // Studio owns the keyboard (R/F/arrow keys are tool & navigation shortcuts).
      keyboardNavEnabled: false,
      animationTime: 0.4,
      crossOriginPolicy: false,
    });

    for (const c of [this.bulk, this.edit]) {
      c.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;";
      this.viewer.canvas.appendChild(c);
    }

    this.viewer.addHandler("open", () => {
      const src = this.viewer.world.getItemAt(0)?.source;
      if (src?.dimensions) {
        this.imageW = src.dimensions.x;
        this.imageH = src.dimensions.y;
      }
      this.setUi({ ready: true, drawer: this.viewer.drawer?.getType?.() ?? "" });
      this.syncView();
      this.drawNow();
    });
    this.viewer.addHandler("open-failed", () => this.setUi({ error: "This slide's tile pyramid could not be opened." }));
    // Fires inside OSD's animation frame, before tiles are drawn: redraw synchronously so overlays never lag.
    this.viewer.addHandler("update-viewport", () => {
      this.syncView();
      this.drawNow();
    });
    this.viewer.addHandler("resize", () => this.resize());
    // A quick click on empty slide with the select tool clears the selection (OSD handled the press).
    this.viewer.addHandler("canvas-click", (e) => {
      if (e.quick && this.pendingDeselect && this.store.tool === "select") this.store.select(null);
      this.pendingDeselect = null;
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(stage);
    this.resize();

    stage.addEventListener("pointerdown", this.onDown, { capture: true });
    stage.addEventListener("pointermove", this.onMove);
    stage.addEventListener("pointerup", this.onUp);
    stage.addEventListener("pointercancel", this.onCancel);
    stage.addEventListener("pointerleave", this.onLeave);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);

    this.rebuild();
    this.unsubscribe = useStudio.subscribe((s, prev) => {
      if (s.annotations !== prev.annotations || s.hiddenLabels !== prev.hiddenLabels) {
        if (this.draft?.kind === "edit" && !s.annotations.some((a) => a.id === (this.draft as { id: string }).id)) this.draft = null;
        this.rebuild();
        this.request(true);
      }
      if (s.selectedId !== prev.selectedId || s.selectedIds !== prev.selectedIds) {
        // Our own group move keeps the selection; anything else cancels an edit in progress.
        if (this.draft?.kind === "edit" && !this.store.selectedIds.includes(this.draft.id)) this.draft = null;
        this.request(true);
        if (s.selectedId !== prev.selectedId) this.revealSelection();
      }
      if (s.overlayOpacity !== prev.overlayOpacity || s.outlineOnly !== prev.outlineOnly || s.lockedLabels !== prev.lockedLabels) this.request(true);
      if (brushSizeOf(s) !== brushSizeOf(prev) || s.activeLabel !== prev.activeLabel) this.request(false);
      if (s.tool !== prev.tool) {
        this.cancelDraft();
        this.updateCursor();
      }
    });
    this.updateCursor();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.unsubscribe();
    this.resizeObserver.disconnect();
    this.stage.removeEventListener("pointerdown", this.onDown, { capture: true });
    this.stage.removeEventListener("pointermove", this.onMove);
    this.stage.removeEventListener("pointerup", this.onUp);
    this.stage.removeEventListener("pointercancel", this.onCancel);
    this.stage.removeEventListener("pointerleave", this.onLeave);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.viewer.destroy();
  }

  // ------------------------------------------------------------------ state

  private setUi(patch: Partial<UiState>) {
    const next = { ...this.ui, ...patch };
    if ((Object.keys(next) as (keyof UiState)[]).every((k) => next[k] === this.ui[k])) return;
    this.ui = next;
    this.onUi(next);
  }

  private get store() {
    return useStudio.getState();
  }

  private rebuild() {
    const s = this.store;
    this.scene.build(visibleFor(s.annotations, this.item.id, s.hiddenLabels));
  }

  private syncView() {
    if (!this.viewer.world.getItemCount()) return;
    this.view.update(this.viewer, this.imageW, this.imageH);
    const mag = Math.round(this.view.scale * this.objective * 100) / 100;
    this.setUi({ mag, rotation: this.viewer.viewport.getRotation(), flipped: this.viewer.viewport.getFlip() });
  }

  private resize() {
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.bulk, this.edit]) {
      if (c.width !== Math.round(w * this.dpr) || c.height !== Math.round(h * this.dpr)) {
        c.width = Math.round(w * this.dpr);
        c.height = Math.round(h * this.dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      }
    }
    this.syncView();
    this.drawNow();
  }

  /** Schedule a redraw on the next animation frame (bulk layer too when `bulk`). */
  request(bulk: boolean) {
    if (bulk) this.dirtyBulk = true;
    this.dirtyEdit = true;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.destroyed) return;
      if (this.dirtyBulk) this.drawBulk();
      if (this.dirtyEdit) this.drawEdit();
      this.dirtyBulk = this.dirtyEdit = false;
    });
  }

  private drawNow() {
    if (!this.ui.ready || this.destroyed) return;
    this.drawBulk();
    this.drawEdit();
    this.dirtyBulk = this.dirtyEdit = false;
  }

  // ------------------------------------------------------------------ public actions

  /** Dev self-check: synthetic objects (not saved) → index build/query and frame timings at the current view. */
  async selfCheck(marks = 50_000, regions = 2_000) {
    const perf = await import("./perf");
    const list = perf.syntheticAnnotations(marks, regions, this.imageW, this.imageH);
    const index = perf.benchIndex(list, this.imageW, this.imageH);
    const frames = perf.benchFrames(list, this.view);
    console.table({ ...index, queryMs: index.queryMs.map((t) => t.toFixed(3)).join(" / "), queryHits: index.queryHits.join(" / ") });
    console.table({ meanFrameMs: frames.mean.toFixed(2), maxFrameMs: frames.max.toFixed(2), ...frames.stats });
    return { index, frames };
  }

  zoomToMagnification(mag: number) {
    const vp = this.viewer.viewport;
    vp.zoomTo(vp.imageToViewportZoom(mag / this.objective));
  }
  zoomBy(f: number) {
    this.viewer.viewport.zoomBy(f);
  }
  goHome() {
    this.viewer.viewport.goHome();
  }
  rotate(delta: number) {
    const vp = this.viewer.viewport;
    vp.setRotation((((vp.getRotation() + delta) % 360) + 360) % 360);
  }
  resetRotation() {
    this.viewer.viewport.setRotation(0);
    this.viewer.viewport.setFlip(false);
  }
  toggleFlip() {
    this.viewer.viewport.toggleFlip();
  }
  toggleNames() {
    this.setUi({ showNames: !this.ui.showNames });
    this.request(true);
  }
  setAdjust(adj: Adjustments, gammaFilterId: string) {
    this.adjust = adj;
    const parts: string[] = [];
    if (adj.brightness !== 1) parts.push(`brightness(${adj.brightness})`);
    if (adj.contrast !== 1) parts.push(`contrast(${adj.contrast})`);
    if (adj.saturation !== 1) parts.push(`saturate(${adj.saturation})`);
    if (adj.gamma !== 1) parts.push(`url(#${gammaFilterId})`);
    // Filter the tile canvas only, so overlays keep their true label colours.
    this.viewer.drawer.canvas.style.filter = parts.join(" ");
  }

  // Keyboard: bound by command id through useCommands (modules/wsi/manifest.ts). Each returns false to decline.

  /** Esc: cancel the shape / edit / area selection in progress; otherwise falls through to deselect. */
  cancelShape(): boolean {
    if (!this.draft) return false;
    this.cancelDraft();
    return true;
  }
  /** Enter: close the polygon / finish the polyline. */
  finishDraft(): boolean {
    if (this.draft?.kind !== "path") return false;
    this.finishPath();
    return true;
  }
  /** Backspace while drawing: drop the last vertex; otherwise falls through to delete selection. */
  removeLastVertex(): boolean {
    const d = this.draft;
    if (d?.kind !== "path") return false;
    d.points.pop();
    if (!d.points.length) this.cancelDraft();
    this.request(false);
    this.emitHint();
    return true;
  }
  holdToPan(): boolean {
    this.spaceHeld = true;
    this.updateCursor();
    return true;
  }

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " ") {
      this.spaceHeld = false;
      this.updateCursor();
    }
  };
  private onBlur = () => {
    this.spaceHeld = false;
    this.updateCursor();
  };

  // ------------------------------------------------------------------ pointer routing

  private screenOf(e: PointerEvent): Pt {
    const r = this.stage.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private claim(e: PointerEvent) {
    e.stopPropagation();
    e.preventDefault();
    this.activePointer = e.pointerId;
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
  }

  private release() {
    if (this.activePointer !== null) {
      try {
        this.stage.releasePointerCapture(this.activePointer);
      } catch {
        /* noop */
      }
    }
    this.activePointer = null;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.ui.ready || this.destroyed) return;
    // Only the slide surface: panels, buttons and the navigator handle their own clicks.
    if (!(e.target instanceof Node) || !this.viewer.canvas.contains(e.target)) return;
    if (e.button !== 0 || this.spaceHeld) return;
    const s = this.store;
    const screen = this.screenOf(e);
    const p = this.view.toImage(...screen);
    const now = performance.now();
    const dbl = now - this.lastDown.t < DBL_CLICK_MS && Math.hypot(screen[0] - this.lastDown.x, screen[1] - this.lastDown.y) < 6;
    this.lastDown = { t: dbl ? 0 : now, x: screen[0], y: screen[1] };
    this.pendingDeselect = null;
    const tool = s.tool;

    if (tool === "pan") return;
    if (tool === "select") {
      this.selectDown(e, p, screen);
      return;
    }
    const label = s.activeLabel;
    if (!label) return;
    this.claim(e);
    switch (tool) {
      case "box":
      case "ellipse":
        this.draft = { kind: "shape", tool, a: p, b: p, square: e.shiftKey };
        break;
      case "length":
        this.draft = { kind: "length", a: p, b: p };
        break;
      case "mark":
        s.add(newAnnotation({ itemId: this.item.id, label, geometry: { type: "mark", x: Math.round(p[0] * 10) / 10, y: Math.round(p[1] * 10) / 10 } }));
        this.release();
        break;
      case "polygon":
      case "polyline":
      case "freehand":
        this.pathDown(tool, p, screen, dbl);
        break;
      case "brush":
      case "eraser":
        this.brushDown(tool === "eraser" || e.altKey, p, screen, e.shiftKey);
        break;
      case "wand":
        this.release();
        void this.runWand(p, e.shiftKey, e.altKey);
        break;
      default:
        this.release();
    }
    this.emitHint();
    this.request(false);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.ui.ready) return;
    const screen = this.screenOf(e);
    this.hover = screen;
    const d = this.draft;
    if (d && this.activePointer === e.pointerId) {
      const p = this.view.toImage(...screen);
      switch (d.kind) {
        case "shape":
          d.b = p;
          d.square = e.shiftKey;
          break;
        case "length":
          d.b = p;
          break;
        case "path":
          if (d.pressing && Math.hypot(screen[0] - d.lastScreen[0], screen[1] - d.lastScreen[1]) > 3) {
            d.points.push(p);
            d.lastScreen = screen;
          }
          break;
        case "brush":
          if (Math.hypot(screen[0] - d.lastScreen[0], screen[1] - d.lastScreen[1]) > 1.5) {
            d.points.push(p);
            d.lastScreen = screen;
          }
          break;
        case "edit":
          this.editMove(d, p, screen);
          break;
        case "area":
          if (d.mode === "rect") d.points[1] = screen;
          else if (Math.hypot(screen[0] - d.points[d.points.length - 1][0], screen[1] - d.points[d.points.length - 1][1]) > 3) d.points.push(screen);
          break;
      }
    } else if (this.store.tool === "select" && !d) {
      const hit = this.hitAt(screen);
      this.stage.style.cursor = this.spaceHeld ? "grab" : hit ? (hit.handle ? "crosshair" : "move") : "";
    }
    this.request(false);
  };

  private onUp = (e: PointerEvent) => {
    if (this.activePointer !== e.pointerId) return;
    this.release();
    const d = this.draft;
    if (!d) return;
    switch (d.kind) {
      case "shape":
        this.finishShape(d);
        break;
      case "length":
        this.finishLength(d);
        break;
      case "path":
        d.pressing = false;
        if (d.tool === "freehand") this.finishPath();
        break;
      case "brush":
        this.finishBrush(d);
        break;
      case "edit":
        this.finishEdit(d);
        break;
      case "area":
        this.finishArea(d);
        break;
    }
    this.emitHint();
    this.request(true);
  };

  private onCancel = (e: PointerEvent) => {
    if (this.activePointer !== e.pointerId) return;
    this.release();
    if (this.draft && this.draft.kind !== "path") this.draft = null;
    this.request(true);
  };

  private onLeave = () => {
    this.hover = null;
    this.request(false);
  };

  private cancelDraft() {
    this.draft = null;
    this.release();
    this.emitHint();
    this.request(true);
  }

  private updateCursor() {
    const tool = this.store.tool;
    this.stage.style.cursor = this.spaceHeld || tool === "pan" ? "grab" : tool === "select" ? "" : tool === "brush" || tool === "eraser" ? "none" : "crosshair";
  }

  private emitHint() {
    const d = this.draft;
    let hint: string | null = null;
    if (d?.kind === "path" && d.tool !== "freehand")
      hint =
        d.tool === "polygon"
          ? `${d.points.length} points · click the first point, double-click or Enter to close · Backspace removes a point · Esc cancels`
          : `${d.points.length} points · double-click or Enter to finish · Backspace removes a point · Esc cancels`;
    if (this.ui.busy) hint = "Growing region…";
    this.setUi({ hint });
  }

  // ------------------------------------------------------------------ select / edit

  private selectedEntry(): Entry | undefined {
    return this.scene.get(this.store.selectedId);
  }

  private editable(a: Annotation) {
    return isEditable(a, this.store.lockedLabels);
  }

  /** Vertex / corner / axis handles of a geometry, in screen px. */
  private handlesOf(g: Geometry): { ref: HandleRef; s: Pt }[] {
    const v = this.view;
    if (g.type === "box") {
      const c: Pt[] = [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]];
      return c.map((p, i) => ({ ref: { kind: "corner", i }, s: v.toScreen(...p) }));
    }
    if (g.type === "ellipse") {
      const r = g.rotation ?? 0, cos = Math.cos(r), sin = Math.sin(r);
      const pts: Pt[] = [
        [g.cx + g.rx * cos, g.cy + g.rx * sin],
        [g.cx - g.rx * cos, g.cy - g.rx * sin],
        [g.cx - g.ry * sin, g.cy + g.ry * cos],
        [g.cx + g.ry * sin, g.cy - g.ry * cos],
      ];
      return pts.map((p, i) => ({ ref: { kind: "axis", i }, s: v.toScreen(...p) }));
    }
    const er = editRings(g);
    if (!er) return [];
    const total = er.rings.reduce((n, r) => n + r.length, 0);
    if (total > MAX_HANDLES) return [];
    const out: { ref: HandleRef; s: Pt }[] = [];
    er.rings.forEach((ring, ri) => ring.forEach((p, i) => out.push({ ref: { kind: "ring", ring: ri, i }, s: v.toScreen(...p) })));
    return out;
  }

  /** What the select tool would grab at a screen point (for the hover cursor and pointerdown). */
  private hitAt(screen: Pt): { entry: Entry; handle?: HandleRef; edge?: { ring: number; index: number } } | null {
    const p = this.view.toImage(...screen);
    const tol = 6 / this.view.scale;
    const sel = this.selectedEntry();
    if (sel && this.editable(sel.a)) {
      const g = sel.a.geometry;
      const handles = this.handlesOf(g);
      let best = -1, bestD = HANDLE_RADIUS;
      handles.forEach((h, i) => {
        const d = Math.hypot(h.s[0] - screen[0], h.s[1] - screen[1]);
        if (d <= bestD) {
          bestD = d;
          best = i;
        }
      });
      if (best >= 0) return { entry: sel, handle: handles[best].ref };
      const er = editRings(g);
      if (er && handles.length) {
        for (let ri = 0; ri < er.rings.length; ri++) {
          const index = hitEdge(p, er.rings[ri], tol, er.closed);
          if (index >= 0) return { entry: sel, edge: { ring: ri, index } };
        }
      }
    }
    const hit = this.scene.hitTest(p, tol);
    if (!hit) return null;
    // Keep the selection when clicking inside it, even if a smaller object overlaps.
    if (sel && hit !== sel && sel.kind === "region" && hit.kind === "region" && pointInRegion(p, sel.region!) && sel.area < hit.area) return { entry: sel };
    return { entry: hit };
  }

  private selectDown(e: PointerEvent, p: Pt, screen: Pt) {
    const s = this.store;
    const hit = this.hitAt(screen);
    if (!hit) {
      // Shift-drag: rectangle selection (adds); Alt-drag: lasso. A plain drag pans.
      if (e.shiftKey || e.altKey) {
        this.claim(e);
        this.draft = { kind: "area", mode: e.altKey ? "lasso" : "rect", points: [screen, screen], additive: e.shiftKey };
        return;
      }
      this.pendingDeselect = screen;
      return; // let OpenSeadragon pan
    }
    const a = hit.entry.a;
    if (e.shiftKey && !hit.handle) {
      this.claim(e);
      this.release();
      s.toggleSelect(a.id);
      return;
    }
    const inMulti = !hit.handle && s.selectedIds.length > 1 && s.selectedIds.includes(a.id);
    if (!inMulti && (s.selectedId !== a.id || s.selectedIds.length > 1)) s.select(a.id);
    if (!this.editable(a)) return; // locked: selectable, and dragging still pans
    this.claim(e);
    if (hit.handle && e.altKey) {
      this.deleteVertex(a, hit.handle);
      this.release();
      return;
    }
    const base = a.geometry;
    const group = inMulti
      ? s.selectedIds
          .map((id) => this.scene.get(id))
          .filter((x): x is Entry => !!x && this.editable(x.a))
          .map((x) => ({ id: x.a.id, base: x.a.geometry, geometry: x.a.geometry }))
      : undefined;
    this.draft = {
      kind: "edit",
      id: a.id,
      base,
      geometry: hit.handle ? cloneGeometry(base) : base,
      mode: hit.handle ? "handle" : "move",
      handle: hit.handle,
      start: p,
      startScreen: screen,
      moved: false,
      insert: hit.edge ? { ring: hit.edge.ring, index: hit.edge.index, p } : undefined,
      group,
      clickSelect: inMulti ? a.id : undefined,
    };
  }

  /** Ids whose centre falls inside the screen-space rectangle / lasso. */
  private areaHits(d: Extract<Draft, { kind: "area" }>): string[] {
    const v = this.view;
    const poly: Pt[] =
      d.mode === "rect"
        ? (() => {
            const [[x0, y0], [x1, y1]] = [d.points[0], d.points[d.points.length - 1]];
            return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Pt[];
          })()
        : d.points;
    if (poly.length < 3) return [];
    const img = poly.map((q) => v.toImage(...q));
    const [minX, minY, maxX, maxY] = ringsBounds([img]);
    const out: string[] = [];
    for (const k of this.scene.search(minX, minY, maxX, maxY)) {
      const e = this.scene.entries[k];
      const c = v.toScreen((e.bbox[0] + e.bbox[2]) / 2, (e.bbox[1] + e.bbox[3]) / 2);
      if (pointInPolygon(c, poly)) out.push(e.a.id);
    }
    return out;
  }

  private finishArea(d: Extract<Draft, { kind: "area" }>) {
    this.draft = null;
    const s = this.store;
    const [a, b] = [d.points[0], d.points[d.points.length - 1]];
    if (d.mode === "rect" && Math.hypot(b[0] - a[0], b[1] - a[1]) < 3) return;
    const hits = this.areaHits(d);
    const ids = d.additive ? [...new Set([...s.selectedIds, ...hits])] : hits;
    s.selectMany(ids);
  }

  private editMove(d: Extract<Draft, { kind: "edit" }>, p: Pt, screen: Pt) {
    if (!d.moved && Math.hypot(screen[0] - d.startScreen[0], screen[1] - d.startScreen[1]) < 3) return;
    d.moved = true;
    if (d.mode === "move") {
      const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
      d.geometry = translateGeometry(d.base, dx, dy);
      if (d.group) for (const g of d.group) g.geometry = translateGeometry(g.base, dx, dy);
      return;
    }
    const h = d.handle!;
    const g = d.geometry;
    if (h.kind === "ring") {
      const er = editRings(g)!;
      er.rings[h.ring][h.i] = p;
      d.geometry = { ...g } as Geometry; // new identity → fresh Path2D
    } else if (h.kind === "corner" && g.type === "box" && d.base.type === "box") {
      const b = d.base;
      const c: Pt[] = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
      const o = c[(h.i + 2) % 4];
      d.geometry = { ...g, x: Math.min(o[0], p[0]), y: Math.min(o[1], p[1]), w: Math.abs(p[0] - o[0]), h: Math.abs(p[1] - o[1]) };
    } else if (h.kind === "axis" && g.type === "ellipse") {
      const r = g.rotation ?? 0;
      const ux = h.i < 2 ? Math.cos(r) : -Math.sin(r), uy = h.i < 2 ? Math.sin(r) : Math.cos(r);
      const len = Math.max(1, Math.abs((p[0] - g.cx) * ux + (p[1] - g.cy) * uy));
      d.geometry = h.i < 2 ? { ...g, rx: len } : { ...g, ry: len };
    }
  }

  private finishEdit(d: Extract<Draft, { kind: "edit" }>) {
    this.draft = null;
    const s = this.store;
    if (!d.moved) {
      if (d.clickSelect) s.select(d.clickSelect);
      if (d.insert) {
        const g = cloneGeometry(d.base);
        const er = editRings(g);
        if (er) {
          er.rings[d.insert.ring].splice(d.insert.index, 0, d.insert.p);
          s.update(d.id, { geometry: g });
        }
      }
      return;
    }
    if (d.group?.length) s.batch({ update: d.group.map((g) => ({ id: g.id, patch: { geometry: g.geometry } })) });
    else s.update(d.id, { geometry: d.geometry });
  }

  private deleteVertex(a: Annotation, h: HandleRef) {
    if (h.kind !== "ring") return;
    const g = cloneGeometry(a.geometry);
    const er = editRings(g);
    if (!er) return;
    const ring = er.rings[h.ring];
    if (ring.length <= (er.closed ? 3 : 2)) return;
    ring.splice(h.i, 1);
    this.store.update(a.id, { geometry: g });
  }

  /** Pan (or zoom out) so a selection made elsewhere (sidebar) is on screen. */
  private revealSelection() {
    const e = this.selectedEntry();
    if (!e || !this.ui.ready) return;
    const [x0, y0, x1, y1] = e.bbox;
    const v = this.view;
    const corners = [v.toScreen(x0, y0), v.toScreen(x1, y0), v.toScreen(x0, y1), v.toScreen(x1, y1)];
    if (corners.every(([x, y]) => x >= 0 && y >= 0 && x <= v.width && y <= v.height)) return;
    const vp = this.viewer.viewport;
    const w = (x1 - x0) * v.scale, h = (y1 - y0) * v.scale;
    if (w < v.width * 0.8 && h < v.height * 0.8) {
      vp.panTo(vp.imageToViewportCoordinates(new OpenSeadragon.Point((x0 + x1) / 2, (y0 + y1) / 2)));
    } else {
      const pad = Math.max(x1 - x0, y1 - y0) * 0.1;
      vp.fitBoundsWithConstraints(vp.imageToViewportRectangle(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad));
    }
  }

  // ------------------------------------------------------------------ drawing tools

  private create(geometry: Geometry, select = true) {
    const s = this.store;
    if (!s.activeLabel) return;
    const a = newAnnotation({ itemId: this.item.id, label: s.activeLabel, geometry });
    s.add(a);
    if (select) s.select(a.id);
  }

  private finishShape(d: Extract<Draft, { kind: "shape" }>) {
    this.draft = null;
    const g = this.shapeDraftGeometry(d);
    const r1 = (n: number) => Math.round(n * 10) / 10;
    if (g.type === "box") {
      if (Math.max(g.w, g.h) * this.view.scale >= 4) this.create({ type: "box", x: r1(g.x), y: r1(g.y), w: r1(g.w), h: r1(g.h) });
    } else if (g.type === "ellipse" && Math.max(g.rx, g.ry) * 2 * this.view.scale >= 4) {
      this.create({ type: "ellipse", cx: r1(g.cx), cy: r1(g.cy), rx: r1(g.rx), ry: r1(g.ry) });
    }
  }

  private shapeDraftGeometry(d: Extract<Draft, { kind: "shape" }>): Geometry {
    let [bx, by] = d.b;
    const [ax, ay] = d.a;
    if (d.square) {
      const side = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
      bx = ax + Math.sign(bx - ax || 1) * side;
      by = ay + Math.sign(by - ay || 1) * side;
    }
    const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
    return d.tool === "box" ? { type: "box", x, y, w, h } : { type: "ellipse", cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
  }

  private finishLength(d: Extract<Draft, { kind: "length" }>) {
    this.draft = null;
    const px = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
    if (px * this.view.scale < 3) return;
    this.create(
      {
        type: "measurement",
        kind: "length",
        points: [d.a, d.b].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
        space: "image",
        stats: lengthStats(px, this.mpp),
        unit: this.mpp ? "µm" : "px",
      },
      false,
    );
  }

  private pathDown(tool: "polygon" | "polyline" | "freehand", p: Pt, screen: Pt, dbl: boolean) {
    const d = this.draft;
    if (tool === "freehand" || !d || d.kind !== "path") {
      this.draft = { kind: "path", tool, points: [p], pressing: true, lastScreen: screen };
      return;
    }
    if (dbl) {
      this.finishPath();
      this.release();
      return;
    }
    if (tool === "polygon" && d.points.length >= 3) {
      const first = this.view.toScreen(...d.points[0]);
      if (Math.hypot(first[0] - screen[0], first[1] - screen[1]) <= CLOSE_RADIUS) {
        this.finishPath();
        this.release();
        return;
      }
    }
    d.points.push(p);
    d.pressing = true;
    d.lastScreen = screen;
  }

  private finishPath() {
    const d = this.draft;
    if (d?.kind !== "path") return;
    this.draft = null;
    this.emitHint();
    // Drop near-duplicate trailing points (double-click leaves one).
    const tol = 0.75 / this.view.scale;
    let pts = d.points.filter((p, i) => i === 0 || Math.hypot(p[0] - d.points[i - 1][0], p[1] - d.points[i - 1][1]) > tol);
    if (d.tool === "freehand") pts = simplify(pts, tol);
    const r1 = (q: Pt[]) => q.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as Pt);
    if (d.tool === "polyline") {
      if (pts.length >= 2) this.create({ type: "polyline", points: r1(pts) });
    } else if (pts.length >= 3 && polygonArea(pts) * this.view.scale ** 2 > 4) {
      this.create({ type: "polygon", points: r1(pts) });
    }
    this.request(true);
  }

  private brushDown(erase: boolean, p: Pt, screen: Pt, shift: boolean) {
    const s = this.store;
    const radius = brushSizeOf(s) / 2 / this.view.scale;
    const sel = this.selectedEntry();
    let addTo: string | null = null;
    // QuPath: a stroke that starts inside the selected region (or any stroke with Shift) edits it.
    if (sel && sel.kind === "region" && this.editable(sel.a) && (erase || sel.a.label === s.activeLabel) && (shift || erase || pointInRegion(p, sel.region!))) addTo = sel.a.id;
    this.draft = { kind: "brush", erase, points: [p], radius, addTo, lastScreen: screen };
  }

  private finishBrush(d: Extract<Draft, { kind: "brush" }>) {
    this.draft = null;
    const stroke = strokeToRegion(d.points, d.radius, this.view.scale);
    if (!stroke.length) return;
    this.applyRegion(stroke, d.erase ? "subtract" : "add", d.addTo);
  }

  /**
   * Merge a painted / wand region into the store. add: union into `target` (or a new
   * annotation); subtract: cut from `target`, or from every editable region of the active
   * label it overlaps. Regions that vanish are removed.
   */
  private applyRegion(region: Region, op: "add" | "subtract", target: string | null) {
    const s = this.store;
    const byId = new Map(s.annotations.map((a) => [a.id, a]));
    if (op === "add") {
      const t = target ? byId.get(target) : undefined;
      const base = t ? regionOf(t.geometry) : null;
      if (t && base) {
        const g = geometryFromRegion(unionRegions(base, region, this.view.scale));
        if (g) s.update(t.id, { geometry: g });
      } else {
        const g = geometryFromRegion(region);
        if (g) this.create(g);
      }
      return;
    }
    const bb: BBox = ringsBounds(region.map((p) => p[0]));
    const targets = target
      ? [byId.get(target)].filter((a): a is Annotation => !!a)
      : [...this.scene.alive()]
          .filter((e) => e.kind === "region" && isRegion(e.a.geometry) && e.a.label === s.activeLabel && this.editable(e.a) && bboxOverlap(e.bbox, bb))
          .map((e) => e.a);
    // Every cut region and removal lands as ONE undo step.
    const remove: string[] = [];
    const update: { id: string; patch: { geometry: Geometry } }[] = [];
    for (const t of targets) {
      const base = regionOf(t.geometry);
      if (!base) continue;
      const cut = subtractRegion(base, region, this.view.scale);
      if (regionArea(cut) === regionArea(base)) continue;
      const g = geometryFromRegion(cut);
      if (!g || regionArea(cut) < 1) remove.push(t.id);
      else update.push({ id: t.id, patch: { geometry: g } });
    }
    if (update.length || remove.length) s.batch({ update, remove });
  }

  private async runWand(p: Pt, shift: boolean, alt: boolean) {
    if (this.ui.busy) return;
    this.setUi({ busy: true });
    this.emitHint();
    const itemId = this.item.id;
    try {
      const region = await wandRegion(this.viewer, this.view, p, this.wandTolerance, this.adjust);
      this.wandRunner = lastWandRunner;
      if (this.destroyed || this.item.id !== itemId || !region.length) return;
      const s = this.store;
      const sel = this.selectedEntry();
      const target = sel && sel.kind === "region" && this.editable(sel.a) && (alt || sel.a.label === s.activeLabel) && (shift || alt) ? sel.a.id : null;
      this.applyRegion(region, alt ? "subtract" : "add", target);
    } catch (err) {
      console.warn("[pathology] wand failed", err);
    } finally {
      if (!this.destroyed) {
        this.setUi({ busy: false });
        this.emitHint();
      }
    }
  }

  // ------------------------------------------------------------------ rendering

  private skipCache: { ids: string[]; extra: string | null; set: Set<string> } | null = null;

  /** Selected objects (and the one being edited) are drawn by the edit layer, not the bulk layer. */
  private skipSet(): Set<string> {
    const ids = this.store.selectedIds;
    const extra = this.draft?.kind === "edit" ? this.draft.id : null;
    const c = this.skipCache;
    if (c && c.ids === ids && c.extra === extra) return c.set;
    const set = new Set(ids);
    if (extra) set.add(extra);
    this.skipCache = { ids, extra, set };
    return set;
  }

  private drawBulk() {
    const ctx = this.bulk.getContext("2d");
    if (!ctx || !this.view.width) return;
    const s = this.store;
    this.lastStats = drawScene(ctx, this.dpr, this.view, this.scene, {
      labels: this.labels,
      opacity: s.overlayOpacity,
      outlineOnly: s.outlineOnly,
      showNames: this.ui.showNames,
      skip: this.skipSet(),
      mpp: this.mpp,
      formatLength: (px) => formatLength(px, this.mpp),
    });
  }

  private drawEdit() {
    const ctx = this.edit.getContext("2d");
    if (!ctx) return;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.edit.width, this.edit.height);
    if (!this.view.width) return;
    const s = this.store;
    const v = this.view;
    const label = s.activeLabel ?? this.labels[0] ?? "";
    let readout: string | null = null;

    const d = this.draft;
    this.drawSecondarySelection(ctx);
    // Selected / edited object.
    const sel = this.selectedEntry();
    if (sel) {
      const g = d?.kind === "edit" && d.id === sel.a.id ? d.geometry : sel.a.geometry;
      const entry = g === sel.a.geometry ? sel : entryFor({ ...sel.a, geometry: g });
      if (entry) {
        this.drawSelected(ctx, entry, this.editable(sel.a));
        if (d?.kind === "edit" && d.moved) readout = this.readoutFor(g);
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const color = resolveLabelColor(this.labels, label);
    if (d?.kind === "area") {
      ctx.save();
      ctx.strokeStyle = resolveToken("--primary");
      ctx.fillStyle = resolveToken("--primary", 0.08);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      if (d.mode === "rect") {
        const [[x0, y0], [x1, y1]] = [d.points[0], d.points[1]];
        ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      } else d.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    if (d?.kind === "shape") {
      const g = this.shapeDraftGeometry(d);
      const e = entryFor({ id: "draft", itemId: this.item.id, label, geometry: g, provenance: "human-created", author: "", createdAt: "" });
      if (e) this.strokeEntry(ctx, e, color, true);
      readout = this.readoutFor(g);
    } else if (d?.kind === "length") {
      const a = v.toScreen(...d.a), b = v.toScreen(...d.b);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      ctx.stroke();
      this.endTicks(ctx, a, b, color);
      readout = formatLength(Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]), this.mpp);
    } else if (d?.kind === "path") {
      const pts = d.points.map((p) => v.toScreen(...p));
      const live = this.hover && d.tool !== "freehand" && !d.pressing ? [...pts, this.hover] : pts;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(d.tool === "freehand" ? [] : [6, 4]);
      ctx.beginPath();
      live.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (d.tool !== "polyline" && live.length > 2) {
        ctx.closePath();
        ctx.fillStyle = resolveLabelColor(this.labels, label, 0.15);
        ctx.fill();
      }
      ctx.stroke();
      ctx.restore();
      if (d.tool !== "freehand") {
        ctx.fillStyle = "#fff";
        pts.forEach(([x, y], i) => {
          ctx.beginPath();
          ctx.arc(x, y, i === 0 ? 4.5 : 3, 0, Math.PI * 2);
          ctx.fill();
        });
        if (d.tool === "polygon" && pts.length >= 3 && this.hover && Math.hypot(this.hover[0] - pts[0][0], this.hover[1] - pts[0][1]) <= CLOSE_RADIUS) {
          ctx.strokeStyle = resolveToken("--primary");
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pts[0][0], pts[0][1], CLOSE_RADIUS, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      const imgLive = this.hover && d.tool !== "freehand" && !d.pressing ? [...d.points, v.toImage(...this.hover)] : d.points;
      readout =
        d.tool === "polyline"
          ? formatLength(pathLength(imgLive), this.mpp)
          : imgLive.length >= 3
            ? `${formatArea(polygonArea(imgLive), this.mpp)} · ${formatLength(pathLength(imgLive, true), this.mpp)}`
            : null;
    } else if (d?.kind === "brush") {
      const pts = d.points.map((p) => v.toScreen(...p));
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = d.radius * 2 * v.scale;
      ctx.strokeStyle = d.erase ? "rgba(255,255,255,0.35)" : resolveLabelColor(this.labels, label, 0.4);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
      ctx.stroke();
      ctx.restore();
    }

    // Brush cursor.
    if ((s.tool === "brush" || s.tool === "eraser") && this.hover) {
      const r = brushSizeOf(s) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(this.hover[0], this.hover[1], r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = s.tool === "eraser" ? "#fff" : color;
      ctx.lineWidth = 1.5;
      if (s.tool === "eraser") ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.restore();
    }

    if (readout && this.hover) pill(ctx, this.hover[0] + 14, this.hover[1] + 26, readout);
    this.drawScaleBar(ctx);
  }

  private readoutFor(g: Geometry): string | null {
    const r = regionOf(g);
    if (r) return `${formatArea(regionArea(r), this.mpp)} · ${formatLength(regionPerimeter(r), this.mpp)}`;
    if (g.type === "polyline") return formatLength(pathLength(g.points), this.mpp);
    if (g.type === "measurement" && g.space === "image") return formatLength(pathLength(g.points as Pt[]), this.mpp);
    return null;
  }

  private endTicks(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, color: string) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = (-(b[1] - a[1]) / len) * 6, ny = ((b[0] - a[0]) / len) * 6;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const p of [a, b]) {
      ctx.moveTo(p[0] - nx, p[1] - ny);
      ctx.lineTo(p[0] + nx, p[1] + ny);
    }
    ctx.stroke();
  }

  private strokeEntry(ctx: CanvasRenderingContext2D, e: Entry, color: string, fill: boolean) {
    const v = this.view;
    ctx.save();
    v.apply(ctx, this.dpr);
    const path = pathFor(e, lodFor(v.scale));
    if (fill && e.kind === "region") {
      ctx.fillStyle = resolveLabelColor(this.labels, e.a.label, 0.18);
      ctx.fill(path, "evenodd");
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / v.scale;
    ctx.stroke(path);
    ctx.restore();
  }

  /**
   * Every selected object except the primary (which gets handles): halo + label outline.
   * Only on-screen ones are drawn, so ⌘A on 50k cells stays cheap. During a group move the
   * moved geometries are drawn instead.
   */
  private drawSecondarySelection(ctx: CanvasRenderingContext2D) {
    const s = this.store;
    if (s.selectedIds.length < 2) return;
    const v = this.view;
    const d = this.draft;
    const moving = d?.kind === "edit" && d.group ? new Map(d.group.map((g) => [g.id, g.geometry])) : null;
    const sel = new Set(s.selectedIds);
    const [x0, y0, x1, y1] = v.visibleImageBounds(24);
    const list: Entry[] = [];
    if (moving) {
      for (const [id, g] of moving) {
        const base = this.scene.get(id);
        if (id === s.selectedId || !base) continue;
        const e = entryFor({ ...base.a, geometry: g });
        if (e) list.push(e);
      }
    } else for (const k of this.scene.search(x0, y0, x1, y1)) if (sel.has(this.scene.entries[k].a.id) && this.scene.entries[k].a.id !== s.selectedId) list.push(this.scene.entries[k]);
    const primary = resolveToken("--primary");
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    for (const e of list) {
      if (e.kind !== "mark") continue;
      const g = e.a.geometry as { x: number; y: number };
      const [x, y] = v.toScreen(g.x, g.y);
      ctx.moveTo(x + 6, y);
      ctx.arc(x, y, 6, 0, Math.PI * 2);
    }
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fill();
    ctx.strokeStyle = primary;
    ctx.lineWidth = 2;
    ctx.stroke();
    const lod = lodFor(v.scale);
    v.apply(ctx, this.dpr);
    for (const e of list) {
      if (e.kind === "mark") continue;
      const path = pathFor(e, lod);
      if (e.kind === "region" && !s.outlineOnly) {
        ctx.fillStyle = resolveLabelColor(this.labels, e.a.label, 0.3 * s.overlayOpacity);
        ctx.fill(path, "evenodd");
      }
      ctx.lineWidth = 5 / v.scale;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.stroke(path);
      ctx.lineWidth = 2.5 / v.scale;
      ctx.strokeStyle = primary;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  private drawSelected(ctx: CanvasRenderingContext2D, e: Entry, editable: boolean) {
    const v = this.view;
    const s = this.store;
    const dpr = this.dpr;
    const ai = e.a.provenance === "ai-suggested";
    const color = resolveLabelColor(this.labels, e.a.label);
    if (e.kind === "mark") {
      const g = e.a.geometry as { x: number; y: number };
      const [x, y] = v.toScreen(g.x, g.y);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 10, 0, Math.PI * 2);
      ctx.strokeStyle = resolveToken("--primary");
      ctx.stroke();
      return;
    }
    const path = pathFor(e, lodFor(v.scale));
    v.apply(ctx, dpr);
    if (e.kind === "region" && !s.outlineOnly) {
      ctx.fillStyle = resolveLabelColor(this.labels, e.a.label, 0.32 * s.overlayOpacity);
      ctx.fill(path, "evenodd");
    }
    // Halo + coloured outline so the selection reads on any stain.
    ctx.lineWidth = 5 / v.scale;
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.stroke(path);
    ctx.lineWidth = 2.5 / v.scale;
    ctx.strokeStyle = ai ? resolveToken("--prov-ai") : color;
    ctx.setLineDash(ai ? [6 / v.scale, 4 / v.scale] : []);
    ctx.stroke(path);
    ctx.setLineDash([]);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (e.kind === "line" && e.a.geometry.type === "measurement") {
      const pts = e.line!.map((p) => v.toScreen(...p));
      if (pts.length >= 2) this.endTicks(ctx, pts[0], pts[pts.length - 1], color);
    }
    if (!editable) {
      const [x, y] = v.toScreen(e.bbox[0], e.bbox[1]);
      pill(ctx, x, y - 4, "locked");
      return;
    }
    const handles = this.handlesOf(e.a.geometry);
    if (handles.length) {
      const hoverIdx = this.hover ? handles.findIndex((h) => Math.hypot(h.s[0] - this.hover![0], h.s[1] - this.hover![1]) <= HANDLE_RADIUS) : -1;
      drawHandles(ctx, handles.map((h) => h.s), hoverIdx, handles.length > 200 ? 5 : 7);
    }
  }

  private drawScaleBar(ctx: CanvasRenderingContext2D) {
    const v = this.view;
    if (!this.mpp || !v.scale) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const umPerPx = this.mpp / v.scale;
    const target = 120 * umPerPx;
    const nice = NICE_UM.find((n) => n >= target * 0.6) ?? NICE_UM[NICE_UM.length - 1];
    const len = nice / umPerPx;
    const h = v.height;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.roundRect(12, h - 38, len + 16, 28, 6);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillRect(20, h - 18, len, 3);
    ctx.font = "11px Inter, sans-serif";
    ctx.fillText(nice >= 1000 ? `${nice / 1000} mm` : `${nice} µm`, 20, h - 23);
  }
}
