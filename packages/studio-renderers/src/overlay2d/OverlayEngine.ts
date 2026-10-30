import { resolveLabelColor, resolveToken } from "@studio/plugin-ui-sdk/labels";
import type { Annotation, Geometry, Placement, Pt } from "@studio/plugin-contracts/types";
import { CLOSE_RADIUS, drawHandles } from "./draw";
import { handlesOf, HANDLE_RADIUS } from "./edit";
import { pathLength, polygonArea } from "./geometry";
import { regionArea, regionOf, regionPerimeter, type BBox, type Region } from "./regions";
import { drawScene, entryFor, lodFor, pathFor, pill, Scene, type DrawStats, type Entry } from "./scene";
import { applyRegion, defaultTools, hitAt, PIXEL_UNITS, shapeGeometry, type Draft, type PointerInput, type RegionOp, type ToolContext, type ToolMachine, type Units } from "./tools";
import type { Transform2D } from "./transform";
import { isEditable, newAnnotation, useHost, visibleFor } from "@studio/plugin-ui-sdk";

export interface OverlayEngineOptions {
  /** Receives pointer events and carries the cursor; overlay canvases are sized to it. */
  stage: HTMLElement;
  /** Where the two overlay canvases go (default: the stage). OSD puts them inside its canvas, below the navigator. */
  layerParent?: HTMLElement;
  itemId: string;
  /** Image ↔ screen map; the host keeps it current and calls `drawNow()` / `request()` after changing it. */
  view: Transform2D;
  /** Label classes in order (colours by position). */
  labels: () => string[];
  units?: Units;
  /** Only annotations on this frame / slice / plane are shown and edited, and new ones are stamped with it. */
  placement?: Placement;
  /** Extra or replacement tool machines by tool name (e.g. a module's wand). */
  tools?: Record<string, ToolMachine>;
  /** Presses on other elements inside the stage (bars, panels, a navigator) are ignored. */
  accepts?: (target: EventTarget | null) => boolean;
  /**
   * The host reports quick clicks itself through `emptyClick()` (OpenSeadragon swallows the
   * pointerup of a click it handled). Otherwise the engine detects them.
   */
  hostClicks?: boolean;
  /** Bring an image-space bbox into view (a selection made elsewhere, e.g. the sidebar). */
  reveal?: (bbox: BBox) => void;
  /** Hint / busy changes for the host's UI. */
  onState?: (s: { hint: string | null; busy: boolean }) => void;
}

const DBL_CLICK_MS = 320;

/** Annotation geometry is on `placement` (every key the placement sets must match). */
export function onPlacement(g: Geometry, placement: Placement | undefined): boolean {
  if (!placement) return true;
  const q = g as Placement;
  return (placement.frame === undefined || q.frame === placement.frame) && (placement.slice === undefined || q.slice === placement.slice) && (placement.plane === undefined || q.plane === placement.plane);
}

const stamp = (g: Geometry, placement: Placement | undefined): Geometry => {
  if (!placement) return g;
  const out = { ...g } as Record<string, unknown>;
  for (const k of ["frame", "slice", "plane"] as const) if (placement[k] !== undefined) out[k] = placement[k];
  return out as Geometry;
};

/**
 * 2D vector editing on any image-plane renderer (todo phase 4, kits/overlay2d): owns the
 * two overlay canvases (bulk: every visible annotation through the spatial index with LOD;
 * edit: selection, handles, drafts, readouts, scale bar), routes pointer events to the
 * active tool machine, and keeps its scene in step with the store through
 * getState/subscribe, never React state, so panning re-renders nothing.
 *
 * The host owns the image and the transform: it updates `view`, then calls `drawNow()`
 * (synchronously inside its own frame, so overlays never lag) or `request()`.
 */
export class OverlayEngine implements ToolContext {
  readonly scene = new Scene();
  readonly bulk = document.createElement("canvas");
  readonly edit = document.createElement("canvas");
  dpr = window.devicePixelRatio || 1;
  lastStats: DrawStats | null = null;
  view: Transform2D;
  units: Units;
  readonly itemId: string;
  /** Pointer handling and drawing start once the host has an image (`setReady`). */
  ready = false;
  busy = false;
  showNames = false;
  private placement: Placement | undefined;
  private tools: Record<string, ToolMachine>;
  private stage: HTMLElement;
  private activePointer: number | null = null;
  private active: ToolMachine | null = null;
  private hover: Pt | null = null;
  private spaceHeld = false;
  private lastDown = { t: 0, x: -99, y: -99 };
  private pendingDeselect: Pt | null = null;
  private frame = 0;
  private dirtyBulk = false;
  private dirtyEdit = false;
  private destroyed = false;
  private hint: string | null = null;
  private unsubscribe: () => void;
  private skipCache: { ids: string[]; extra: string | null; set: Set<string> } | null = null;

  constructor(private opts: OverlayEngineOptions) {
    this.stage = opts.stage;
    this.view = opts.view;
    this.itemId = opts.itemId;
    this.units = opts.units ?? PIXEL_UNITS;
    this.placement = opts.placement;
    this.tools = { ...defaultTools(), ...opts.tools };
    const parent = opts.layerParent ?? opts.stage;
    for (const c of [this.bulk, this.edit]) {
      c.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;";
      parent.appendChild(c);
    }
    const st = this.stage;
    st.addEventListener("pointerdown", this.onDown, { capture: true });
    st.addEventListener("pointermove", this.onMove);
    st.addEventListener("pointerup", this.onUp);
    st.addEventListener("pointercancel", this.onCancel);
    st.addEventListener("pointerleave", this.onLeave);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);

    this.rebuild();
    this.unsubscribe = useHost.subscribe((s, prev) => {
      if (s.annotations !== prev.annotations || s.hiddenLabels !== prev.hiddenLabels) {
        const d = this.current()?.draft();
        if (d?.kind === "edit" && !s.annotations.some((a) => a.id === d.id)) this.current()?.cancel();
        this.rebuild();
        this.request(true);
      }
      if (s.selectedId !== prev.selectedId || s.selectedIds !== prev.selectedIds) {
        // Our own group move keeps the selection; anything else cancels an edit in progress.
        const d = this.current()?.draft();
        if (d?.kind === "edit" && !s.selectedIds.includes(d.id)) this.current()?.cancel();
        this.request(true);
        if (s.selectedId !== prev.selectedId) this.revealSelection();
      }
      if (s.overlayOpacity !== prev.overlayOpacity || s.outlineOnly !== prev.outlineOnly || s.lockedLabels !== prev.lockedLabels) this.request(true);
      if (s.toolOptions !== prev.toolOptions || s.activeLabel !== prev.activeLabel) this.request(false);
      if (s.tool !== prev.tool) {
        this.tools[prev.tool]?.cancel();
        this.release();
        this.emitHint();
        this.request(true);
        this.updateCursor();
      }
    });
    this.updateCursor();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.unsubscribe();
    const st = this.stage;
    st.removeEventListener("pointerdown", this.onDown, { capture: true });
    st.removeEventListener("pointermove", this.onMove);
    st.removeEventListener("pointerup", this.onUp);
    st.removeEventListener("pointercancel", this.onCancel);
    st.removeEventListener("pointerleave", this.onLeave);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.bulk.remove();
    this.edit.remove();
  }

  // ------------------------------------------------------------------ host API

  setReady(ready = true) {
    this.ready = ready;
    this.drawNow();
  }

  setPlacement(placement: Placement | undefined) {
    const p = this.placement;
    if (p?.frame === placement?.frame && p?.slice === placement?.slice && p?.plane === placement?.plane) return;
    this.placement = placement;
    this.current()?.cancel();
    this.release();
    this.rebuild();
    this.request(true);
  }

  setShowNames(on: boolean) {
    this.showNames = on;
    this.request(true);
  }

  setUnits(units: Units) {
    this.units = units;
    this.request(true);
  }

  /** Match the canvases to the stage (CSS px × devicePixelRatio). */
  resize(w = this.stage.clientWidth, h = this.stage.clientHeight) {
    this.dpr = window.devicePixelRatio || 1;
    for (const c of [this.bulk, this.edit]) {
      if (c.width !== Math.round(w * this.dpr) || c.height !== Math.round(h * this.dpr)) {
        c.width = Math.round(w * this.dpr);
        c.height = Math.round(h * this.dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
      }
    }
  }

  /** Schedule a redraw on the next animation frame (bulk layer too when `bulk`). */
  request(bulk = true) {
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

  /** Redraw both layers now (call from the host's own frame after the view changed). */
  drawNow() {
    if (!this.ready || this.destroyed) return;
    this.drawBulk();
    this.drawEdit();
    this.dirtyBulk = this.dirtyEdit = false;
  }

  /** The host saw a quick click (no drag) that it handled itself, e.g. OpenSeadragon's canvas-click. */
  emptyClick(quick: boolean) {
    if (quick && this.pendingDeselect && this.store().tool === "select") this.store().select(null);
    this.pendingDeselect = null;
  }

  // Keyboard: the host binds these to commands (useCommands); each returns false to decline.

  /** Esc: cancel the shape / edit / area selection in progress; otherwise falls through. */
  cancelShape(): boolean {
    const m = this.current();
    if (!m?.draft()) return false;
    this.cancelDraft();
    return true;
  }
  /** Enter: close the polygon / finish the polyline. */
  finishShape(): boolean {
    const m = this.current();
    if (m?.draft()?.kind !== "path" || !m.finish) return false;
    m.finish(this);
    this.emitHint();
    this.request(true);
    return true;
  }
  /** Backspace while drawing: drop the last vertex; otherwise falls through. */
  removeLastVertex(): boolean {
    const m = this.current();
    if (m?.draft()?.kind !== "path" || !m.removeLast?.(this)) return false;
    if (!m.draft()) this.release();
    this.emitHint();
    this.request(false);
    return true;
  }
  /** Space held: presses go to the host (pan) whatever the tool. */
  holdToPan(): boolean {
    this.spaceHeld = true;
    this.updateCursor();
    return true;
  }

  // ------------------------------------------------------------------ ToolContext

  store() {
    return useHost.getState();
  }

  editable(a: Annotation) {
    return isEditable(a, this.store().lockedLabels);
  }

  selected(): Entry | undefined {
    return this.scene.get(this.store().selectedId);
  }

  create(geometry: Geometry, select = true): Annotation | null {
    const s = this.store();
    if (!s.activeLabel) return null;
    const a = newAnnotation({ itemId: this.itemId, label: s.activeLabel, geometry: stamp(geometry, this.placement) });
    s.add(a);
    if (select) s.select(a.id);
    return a;
  }

  applyRegion(region: Region, op: RegionOp, target: string | null) {
    applyRegion(this, region, op, target);
  }

  deselectOnClick(screen: Pt) {
    this.pendingDeselect = screen;
  }

  setBusy(busy: boolean) {
    if (this.destroyed) return;
    this.busy = busy;
    this.emitHint(true);
  }

  // ------------------------------------------------------------------ internals

  private current(): ToolMachine | undefined {
    return this.tools[this.store().tool];
  }

  private rebuild() {
    const s = this.store();
    const visible = visibleFor(s.annotations, this.itemId, s.hiddenLabels);
    this.scene.build(this.placement ? visible.filter((a) => onPlacement(a.geometry, this.placement)) : visible);
  }

  private input(e: PointerEvent, screen: Pt, dbl = false): PointerInput {
    return { screen, p: this.view.toImage(...screen), shift: e.shiftKey, alt: e.altKey, dbl };
  }

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
    this.active = null;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.ready || this.destroyed) return;
    if (this.opts.accepts && !this.opts.accepts(e.target)) return;
    if (e.button !== 0 || this.spaceHeld) return;
    const s = this.store();
    const screen = this.screenOf(e);
    const now = performance.now();
    const dbl = now - this.lastDown.t < DBL_CLICK_MS && Math.hypot(screen[0] - this.lastDown.x, screen[1] - this.lastDown.y) < 6;
    this.lastDown = { t: dbl ? 0 : now, x: screen[0], y: screen[1] };
    this.pendingDeselect = null;
    const m = this.tools[s.tool];
    if (!m || (m.needsLabel && !s.activeLabel)) return;
    const res = m.down(this.input(e, screen, dbl), this);
    if (res === "claim") {
      this.claim(e);
      this.active = m;
    } else if (res === "consume") {
      e.stopPropagation();
      e.preventDefault();
    }
    this.emitHint();
    this.request(false);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.ready) return;
    const screen = this.screenOf(e);
    this.hover = screen;
    if (this.active && this.activePointer === e.pointerId) this.active.move?.(this.input(e, screen), this);
    else if (this.store().tool === "select" && !this.current()?.draft()) {
      const hit = hitAt(this, screen);
      this.stage.style.cursor = this.spaceHeld ? "grab" : hit ? (hit.handle ? "crosshair" : "move") : "";
    }
    this.request(false);
  };

  private onUp = (e: PointerEvent) => {
    if (this.activePointer !== e.pointerId) {
      // Hosts that don't report clicks: a press-release on empty canvas without a drag deselects.
      if (!this.opts.hostClicks && this.pendingDeselect) {
        const p = this.screenOf(e);
        this.emptyClick(Math.hypot(p[0] - this.pendingDeselect[0], p[1] - this.pendingDeselect[1]) < 4);
      }
      return;
    }
    const m = this.active;
    this.release();
    if (!m) return;
    m.up?.(this.input(e, this.screenOf(e)), this);
    this.emitHint();
    this.request(true);
  };

  private onCancel = (e: PointerEvent) => {
    if (this.activePointer !== e.pointerId) return;
    const m = this.active;
    this.release();
    if (m?.lost) m.lost(this);
    else m?.cancel();
    this.request(true);
  };

  private onLeave = () => {
    this.hover = null;
    this.request(false);
  };

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

  private cancelDraft() {
    this.current()?.cancel();
    this.release();
    this.emitHint();
    this.request(true);
  }

  private updateCursor() {
    const tool = this.store().tool;
    this.stage.style.cursor = this.spaceHeld || tool === "pan" ? "grab" : (this.tools[tool]?.cursor ?? "crosshair");
  }

  private emitHint(force = false) {
    const hint = this.busy ? "Growing region…" : (this.current()?.hint?.() ?? null);
    if (!force && hint === this.hint) return;
    this.hint = hint;
    this.opts.onState?.({ hint, busy: this.busy });
  }

  /** Pan (or zoom out) so a selection made elsewhere (sidebar) is on screen. */
  private revealSelection() {
    const e = this.selected();
    if (!e || !this.ready || !this.opts.reveal) return;
    const [x0, y0, x1, y1] = e.bbox;
    const v = this.view;
    const corners = [v.toScreen(x0, y0), v.toScreen(x1, y0), v.toScreen(x0, y1), v.toScreen(x1, y1)];
    if (corners.every(([x, y]) => x >= 0 && y >= 0 && x <= v.width && y <= v.height)) return;
    this.opts.reveal(e.bbox);
  }

  // ------------------------------------------------------------------ rendering

  /** Selected objects (and the one being edited) are drawn by the edit layer, not the bulk layer. */
  private skipSet(): Set<string> {
    const ids = this.store().selectedIds;
    const d = this.current()?.draft();
    const extra = d?.kind === "edit" ? d.id : null;
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
    const s = this.store();
    this.lastStats = drawScene(ctx, this.dpr, this.view, this.scene, {
      labels: this.opts.labels(),
      opacity: s.overlayOpacity,
      outlineOnly: s.outlineOnly,
      showNames: this.showNames,
      skip: this.skipSet(),
      mpp: this.units.scaleBar?.perPx ?? null,
      formatLength: (px) => this.units.formatLength(px),
    });
  }

  private drawEdit() {
    const ctx = this.edit.getContext("2d");
    if (!ctx) return;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.edit.width, this.edit.height);
    if (!this.view.width) return;
    const s = this.store();
    const v = this.view;
    const u = this.units;
    const labels = this.opts.labels();
    const label = s.activeLabel ?? labels[0] ?? "";
    const m = this.current();
    const d = m?.draft() ?? null;
    let readout: string | null = null;

    this.drawSecondarySelection(ctx, d, labels);
    const sel = this.selected();
    if (sel) {
      const g = d?.kind === "edit" && d.id === sel.a.id ? d.geometry : sel.a.geometry;
      const entry = g === sel.a.geometry ? sel : entryFor({ ...sel.a, geometry: g });
      if (entry) {
        this.drawSelected(ctx, entry, this.editable(sel.a), labels);
        if (d?.kind === "edit" && d.moved) readout = this.readoutFor(g);
      }
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const color = resolveLabelColor(labels, label);
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
    } else if (d?.kind === "shape") {
      const g = shapeGeometry(d);
      const e = entryFor({ id: "draft", itemId: this.itemId, label, geometry: g, provenance: "human-created", author: "", createdAt: "" });
      if (e) this.strokeEntry(ctx, e, color, labels);
      readout = this.readoutFor(g);
    } else if (d?.kind === "length") {
      const a = v.toScreen(...d.a), b = v.toScreen(...d.b);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(...a);
      ctx.lineTo(...b);
      ctx.stroke();
      endTicks(ctx, a, b, color);
      readout = u.formatLength(Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]));
    } else if (d?.kind === "path") {
      readout = this.drawPathDraft(ctx, d, color, labels, label);
    } else if (d?.kind === "brush") {
      const pts = d.points.map((p) => v.toScreen(...p));
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = d.radius * 2 * v.scale;
      ctx.strokeStyle = d.erase ? "rgba(255,255,255,0.35)" : resolveLabelColor(labels, label, 0.4);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.01, pts[0][1]);
      ctx.stroke();
      ctx.restore();
    }

    const ring = this.hover && m?.ring?.(this);
    if (ring && this.hover) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(this.hover[0], this.hover[1], ring.radius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = ring.erase ? "#fff" : color;
      ctx.lineWidth = 1.5;
      if (ring.erase) ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.restore();
    }

    if (readout && this.hover) pill(ctx, this.hover[0] + 14, this.hover[1] + 26, readout);
    this.drawScaleBar(ctx);
  }

  private drawPathDraft(ctx: CanvasRenderingContext2D, d: Extract<Draft, { kind: "path" }>, color: string, labels: string[], label: string): string | null {
    const v = this.view, u = this.units;
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
      ctx.fillStyle = resolveLabelColor(labels, label, 0.15);
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
    if (d.tool === "polyline") return u.formatLength(pathLength(imgLive));
    return imgLive.length >= 3 ? `${u.formatArea(polygonArea(imgLive))} · ${u.formatLength(pathLength(imgLive, true))}` : null;
  }

  private readoutFor(g: Geometry): string | null {
    const u = this.units;
    const r = regionOf(g);
    if (r) return `${u.formatArea(regionArea(r))} · ${u.formatLength(regionPerimeter(r))}`;
    if (g.type === "polyline") return u.formatLength(pathLength(g.points));
    if (g.type === "measurement" && g.space === "image") return u.formatLength(pathLength(g.points as Pt[]));
    return null;
  }

  private strokeEntry(ctx: CanvasRenderingContext2D, e: Entry, color: string, labels: string[]) {
    const v = this.view;
    ctx.save();
    v.apply(ctx, this.dpr);
    const path = pathFor(e, lodFor(v.scale));
    if (e.kind === "region") {
      ctx.fillStyle = resolveLabelColor(labels, e.a.label, 0.18);
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
  private drawSecondarySelection(ctx: CanvasRenderingContext2D, d: Draft | null, labels: string[]) {
    const s = this.store();
    if (s.selectedIds.length < 2) return;
    const v = this.view;
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
        ctx.fillStyle = resolveLabelColor(labels, e.a.label, 0.3 * s.overlayOpacity);
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

  private drawSelected(ctx: CanvasRenderingContext2D, e: Entry, editable: boolean, labels: string[]) {
    const v = this.view;
    const s = this.store();
    const dpr = this.dpr;
    const ai = e.a.provenance === "ai-suggested";
    const color = resolveLabelColor(labels, e.a.label);
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
      ctx.fillStyle = resolveLabelColor(labels, e.a.label, 0.32 * s.overlayOpacity);
      ctx.fill(path, "evenodd");
    }
    // Halo + coloured outline so the selection reads on any background.
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
      if (pts.length >= 2) endTicks(ctx, pts[0], pts[pts.length - 1], color);
    }
    if (!editable) {
      const [x, y] = v.toScreen(e.bbox[0], e.bbox[1]);
      pill(ctx, x, y - 4, "locked");
      return;
    }
    const handles = handlesOf(e.a.geometry, v);
    if (handles.length) {
      const hover = this.hover;
      const hoverIdx = hover ? handles.findIndex((h) => Math.hypot(h.s[0] - hover[0], h.s[1] - hover[1]) <= HANDLE_RADIUS) : -1;
      drawHandles(ctx, handles.map((h) => h.s), hoverIdx, handles.length > 200 ? 5 : 7);
    }
  }

  private drawScaleBar(ctx: CanvasRenderingContext2D) {
    const v = this.view;
    const bar = this.units.scaleBar;
    if (!bar || !bar.perPx || !v.scale) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const perScreenPx = bar.perPx / v.scale;
    const target = 120 * perScreenPx;
    const nice = bar.steps.find((n) => n >= target * 0.6) ?? bar.steps[bar.steps.length - 1];
    const len = nice / perScreenPx;
    const h = v.height;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.roundRect(12, h - 38, len + 16, 28, 6);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillRect(20, h - 18, len, 3);
    ctx.font = "11px Inter, sans-serif";
    ctx.fillText(bar.format(nice), 20, h - 23);
  }
}

function endTicks(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, color: string) {
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
