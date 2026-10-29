import { HANDLE_CURSORS, shapeUtil, type Hit } from "@/kits/overlay2d/shapes";
import { CLOSE_RADIUS } from "@/kits/overlay2d/draw";
import type { Annotation, Geometry, Pt } from "@/types";

/**
 * Tool state machine of the canvas-raster renderer: select / move / resize through the
 * overlay2d ShapeUtils, and the `box`, `polygon` and `keypoint` drawing tools creating core
 * geometries in image pixels. Pure (no DOM, no store): the host passes screen points and
 * applies what comes out through `EditorEnv`, so the behaviour is unit-tested and can move
 * onto a shared overlay2d engine later without changing the renderer.
 */
export interface EditorEnv {
  /** Visible annotations of the current item, bottom to top. */
  annotations(): Annotation[];
  selectedIds(): string[];
  /** Whether an annotation may be moved or reshaped (locks). */
  editable(a: Annotation): boolean;
  toScreen(x: number, y: number): Pt;
  toImage(sx: number, sy: number): Pt;
  /** Image size in pixels; created and edited points are clamped to it. */
  size(): [number, number];
  select(id: string | null): void;
  toggle(id: string): void;
  create(geometry: Geometry): void;
  /** One undoable step for every reshaped / moved annotation. */
  commit(changes: { id: string; geometry: Geometry }[]): void;
  pan(dx: number, dy: number): void;
}

export interface Modifiers {
  shift?: boolean;
  mod?: boolean;
}

export type Draft = { kind: "box"; a: Pt; b: Pt } | { kind: "polygon"; points: Pt[]; hover?: Pt };

type Drag =
  | { kind: "pan"; last: Pt }
  | { kind: "box" }
  | { kind: "move"; from: Pt; at: Pt; originals: Map<string, Geometry> }
  | { kind: "handle"; id: string; index: number; original: Geometry; at: Pt };

/** Screen pixels a pointer must travel before a press becomes a drag. */
const DRAG_SLOP = 3;
export const DRAWING_TOOLS = ["box", "polygon", "keypoint"] as const;

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Round a planar geometry to 0.01 px (the precision the Cornerstone renderer stores). */
export function roundGeometry(g: Geometry): Geometry {
  switch (g.type) {
    case "box":
      return { ...g, x: r2(g.x), y: r2(g.y), w: r2(g.w), h: r2(g.h) };
    case "keypoint":
      return { ...g, x: r2(g.x), y: r2(g.y) };
    case "polygon":
    case "polyline":
    case "spline":
      return { ...g, points: g.points.map(([x, y]) => [r2(x), r2(y)] as Pt) };
    case "ellipse":
      return { ...g, cx: r2(g.cx), cy: r2(g.cy), rx: r2(g.rx), ry: r2(g.ry) };
    default:
      return g;
  }
}

export class RasterEditor {
  draft: Draft | null = null;
  /** Live geometry of annotations being moved or reshaped, drawn instead of the stored one. */
  readonly preview = new Map<string, Geometry>();
  private drag: Drag | null = null;
  private pressAt: Pt | null = null;

  constructor(private readonly env: EditorEnv) {}

  get busy(): boolean {
    return !!this.drag || !!this.draft;
  }

  private clamp([x, y]: Pt): Pt {
    const [w, h] = this.env.size();
    return [Math.max(0, Math.min(w, x)), Math.max(0, Math.min(h, y))];
  }

  private image(p: Pt): Pt {
    return this.env.toImage(p[0], p[1]);
  }

  /** Topmost hit at screen point p: handles of selected editable shapes first, then bodies. */
  hitTest(p: Pt): { annotation: Annotation; hit: Hit } | null {
    const list = this.env.annotations();
    const selected = new Set(this.env.selectedIds());
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      if (!selected.has(a.id) || !this.env.editable(a)) continue;
      const hit = shapeUtil(a.geometry)?.hitTest(a.geometry, p, this.env.toScreen, { selected: true });
      if (hit && hit.part === "handle") return { annotation: a, hit };
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      const hit = shapeUtil(a.geometry)?.hitTest(a.geometry, p, this.env.toScreen);
      if (hit) return { annotation: a, hit: { part: "body" } };
    }
    return null;
  }

  /** Pointer pressed at screen point p. `pan` forces a pan drag (Space held, middle button). */
  down(tool: string, p: Pt, mods: Modifiers = {}, pan = false): void {
    this.pressAt = p;
    if (pan || tool === "pan") {
      this.drag = { kind: "pan", last: p };
      return;
    }
    const at = this.clamp(this.image(p));
    switch (tool) {
      case "select":
        return this.selectDown(p, mods);
      case "box":
        this.draft = { kind: "box", a: at, b: at };
        this.drag = { kind: "box" };
        return;
      case "keypoint":
        this.env.create(roundGeometry({ type: "keypoint", x: at[0], y: at[1] }));
        return;
      case "polygon":
        return this.polygonDown(p, at);
    }
  }

  private selectDown(p: Pt, mods: Modifiers) {
    const target = this.hitTest(p);
    if (!target) {
      if (!mods.shift && !mods.mod) this.env.select(null);
      return;
    }
    const { annotation: a, hit } = target;
    if (mods.shift || mods.mod) {
      this.env.toggle(a.id);
      return;
    }
    if (hit.part === "handle") {
      this.drag = { kind: "handle", id: a.id, index: hit.index, original: a.geometry, at: p };
      return;
    }
    if (!this.env.selectedIds().includes(a.id)) this.env.select(a.id);
    const ids = new Set(this.env.selectedIds());
    const originals = new Map(this.env.annotations().filter((x) => ids.has(x.id) && this.env.editable(x)).map((x) => [x.id, x.geometry] as const));
    if (originals.size) this.drag = { kind: "move", from: this.image(p), at: p, originals };
  }

  private polygonDown(p: Pt, at: Pt) {
    const d = this.draft;
    if (d?.kind !== "polygon") {
      this.draft = { kind: "polygon", points: [at] };
      return;
    }
    const screen = d.points.map(([x, y]) => this.env.toScreen(x, y));
    const [fx, fy] = screen[0];
    const [lx, ly] = screen[screen.length - 1];
    // Clicking the first vertex closes; a second click on the last one (double-click) finishes.
    if (d.points.length >= 3 && (Math.hypot(p[0] - fx, p[1] - fy) <= CLOSE_RADIUS || Math.hypot(p[0] - lx, p[1] - ly) <= 2)) {
      this.finish();
      return;
    }
    if (Math.hypot(p[0] - lx, p[1] - ly) <= 2) return;
    d.points.push(at);
  }

  /** Pointer moved to screen point p; true when something must be redrawn. */
  move(p: Pt): boolean {
    const d = this.drag;
    if (this.draft?.kind === "polygon" && !d) {
      this.draft.hover = this.clamp(this.image(p));
      return true;
    }
    if (!d) return false;
    switch (d.kind) {
      case "pan":
        this.env.pan(p[0] - d.last[0], p[1] - d.last[1]);
        d.last = p;
        return true;
      case "box":
        if (this.draft?.kind === "box") this.draft.b = this.clamp(this.image(p));
        return true;
      case "handle": {
        d.at = p;
        if (!this.moved(p)) return false;
        const u = shapeUtil(d.original);
        if (u) this.preview.set(d.id, u.applyHandle(d.original, d.index, this.clamp(this.image(p))));
        return true;
      }
      case "move": {
        d.at = p;
        if (!this.moved(p)) return false;
        const [x, y] = this.image(p);
        let dx = x - d.from[0], dy = y - d.from[1];
        // Keep the whole selection inside the image.
        const [w, h] = this.env.size();
        for (const g of d.originals.values()) {
          const b = shapeUtil(g)?.bounds(g);
          if (!b) continue;
          dx = Math.max(-b[0], Math.min(w - b[2], dx));
          dy = Math.max(-b[1], Math.min(h - b[3], dy));
        }
        for (const [id, g] of d.originals) {
          const u = shapeUtil(g);
          if (u) this.preview.set(id, u.translate(g, dx, dy));
        }
        return true;
      }
    }
  }

  private moved(p: Pt): boolean {
    const s = this.pressAt;
    return !!s && Math.hypot(p[0] - s[0], p[1] - s[1]) >= DRAG_SLOP;
  }

  /** Pointer released; commits a drawn box or an edit. */
  up(p: Pt): void {
    const d = this.drag;
    if (!d) return;
    // A release without an intermediate move still lands where it is released.
    if (d.kind === "handle" || d.kind === "move") this.move(p);
    this.drag = null;
    if (d.kind === "box" && this.draft?.kind === "box") {
      const { a } = this.draft;
      const b = this.clamp(this.image(p));
      this.draft = null;
      const [sa, sb] = [this.env.toScreen(a[0], a[1]), this.env.toScreen(b[0], b[1])];
      if (Math.abs(sa[0] - sb[0]) < DRAG_SLOP || Math.abs(sa[1] - sb[1]) < DRAG_SLOP) return;
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
      this.env.create(roundGeometry({ type: "box", x, y, w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) }));
      return;
    }
    if (d.kind === "handle" || d.kind === "move") {
      const changes = [...this.preview].map(([id, geometry]) => ({ id, geometry: roundGeometry(geometry) }));
      this.preview.clear();
      if (changes.length) this.env.commit(changes);
    }
  }

  /** Close the polygon being drawn (Enter, double-click). False when there is none. */
  finish(): boolean {
    const d = this.draft;
    if (d?.kind !== "polygon") return false;
    this.draft = null;
    if (d.points.length >= 3) this.env.create(roundGeometry({ type: "polygon", points: d.points }));
    return true;
  }

  /** Abandon the shape or drag in progress (Escape). False when there is none. */
  cancel(): boolean {
    const had = !!this.draft || this.preview.size > 0;
    this.draft = null;
    this.drag = null;
    this.preview.clear();
    return had;
  }

  /** Drop the last vertex of the polygon being drawn (Backspace). False when there is none. */
  removeLastVertex(): boolean {
    const d = this.draft;
    if (d?.kind !== "polygon") return false;
    d.points.pop();
    if (!d.points.length) this.draft = null;
    return true;
  }

  /** CSS cursor for the pointer at screen point p. */
  cursor(tool: string, p: Pt | null, pan: boolean): string {
    if (pan || tool === "pan") return this.drag?.kind === "pan" ? "grabbing" : "grab";
    if (tool !== "select") return (DRAWING_TOOLS as readonly string[]).includes(tool) ? "crosshair" : "default";
    if (this.drag?.kind === "move") return "move";
    if (!p) return "default";
    const t = this.hitTest(p);
    if (!t) return "default";
    if (t.hit.part === "handle") {
      const g = t.annotation.geometry;
      return g.type === "box" || g.type === "ellipse" ? HANDLE_CURSORS[t.hit.index] ?? "move" : "move";
    }
    return this.env.editable(t.annotation) ? "move" : "pointer";
  }
}
