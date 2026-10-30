import { resolveLabelColor, resolveToken } from "@studio/plugin-ui-sdk/labels";
import { CLOSE_RADIUS, drawHandles, drawTag } from "@studio/renderers/overlay2d/draw";
import { drawShape, HANDLE_CURSORS, shapeUtil, type Hit, type ToScreen } from "@studio/renderers/overlay2d/shapes";
import type { Annotation, Geometry, Pt } from "@studio/contracts/types";
import { placeTrack, resolveTrack, unplace } from "../trackShape";
import { applyShape, isSpatial, shapeData, shapeOnFrame, frameGeometry, type TrackGeometry } from "../tracks";

/**
 * Thin per-frame 2D editing for the video renderer: what is on the current frame, hit
 * testing, box / polygon / keypoint drafting, handle and body drags. Geometry operations
 * all go through kits/overlay2d ShapeUtils; tracks are placed on the frame (`placeTrack`)
 * so their ShapeUtil resolves the interpolated shape and writes keyframes. Holds no React
 * state: the host calls `sync()` every render and redraws on `onChange`.
 */

/** One annotation as it appears on the current frame. */
export interface FrameItem {
  a: Annotation;
  /** Stored geometry, tracks placed on the frame. Edits apply to this. */
  placed: Geometry;
  /** Core geometry drawn on this frame. */
  view: Geometry;
  occluded: boolean;
  keyframe: boolean;
  /** "#3 polyp" for tracks, "polyp" for per-frame shapes. */
  tag: string;
  editable: boolean;
}

export function frameItems(visible: Annotation[], frame: number, numbers: Map<string, number>, editable: (a: Annotation) => boolean): FrameItem[] {
  return visible.flatMap((a) => {
    if (!isSpatial(a.geometry)) return [];
    const s = shapeOnFrame(a.geometry, frame);
    if (!s) return [];
    const n = numbers.get(a.id);
    const placed = a.geometry.type === "track" ? placeTrack(a.geometry, frame) : a.geometry;
    return [{ a, placed, view: frameGeometry(s), occluded: s.occluded, keyframe: s.keyframe, tag: n ? `#${n} ${a.label}` : a.label, editable: editable(a) }];
  });
}

export type DrawKind = "box" | "polygon" | "keypoint";
const DRAWING = new Set(["box", "polygon", "keypoint"]);

export interface EditorInputs {
  tool: string;
  frame: number;
  dims: { width: number; height: number };
  items: FrameItem[];
  selectedId: string | null;
  selectedIds: ReadonlySet<string>;
  labels: string[];
  activeLabel: string | null;
  opacity: number;
  ready: boolean;
  playing: boolean;
  scale: number;
  toScreen: ToScreen;
  toContent: (x: number, y: number) => Pt;
  pan: { start: (e: React.PointerEvent) => void; move: (e: React.PointerEvent) => void; end: () => void };
  canDraw: () => boolean;
  create: (kind: DrawKind, shape: Geometry) => void;
  /** Store an edited geometry (tracks already unplaced). */
  commit: (id: string, g: Geometry) => void;
  addEvent: () => void;
  pause: () => void;
  select: (id: string | null) => void;
  toggleSelect: (id: string) => void;
}

type Action =
  | { kind: "pan" }
  | { kind: "draw-box"; a: Pt; b: Pt }
  | { kind: "edit"; id: string; hit: Hit; start: Pt; orig: Geometry; live: Geometry | null };

type ItemHit = Hit & { id: string };

export class FrameEditor {
  /** Space held: drags pan whatever the tool; `panned` once it did (a tap toggles playback). */
  space = { down: false, panned: false };
  draft: Pt[] | null = null;
  private cursor: Pt | null = null;
  private action: Action | null = null;
  private i!: EditorInputs;

  constructor(private onChange: () => void) {}

  sync(inputs: EditorInputs) {
    this.i = inputs;
    if (inputs.tool !== "polygon") this.draft = null;
  }

  private setDraft(d: Pt[] | null) {
    this.draft = d;
    this.onChange();
  }
  cancelDraft = () => (this.draft ? (this.setDraft(null), true) : false);
  removeLastVertex = () => (this.draft ? (this.setDraft(this.draft.length > 1 ? this.draft.slice(0, -1) : null), true) : false);
  finishDraft = () => (this.draft ? (this.closePolygon(), true) : false);

  private closePolygon(pts = this.draft) {
    this.setDraft(null);
    if (pts && pts.length >= 3) this.i.create("polygon", { type: "polygon", points: pts });
  }

  private clamp = ([x, y]: Pt): Pt => [Math.max(0, Math.min(this.i.dims.width, x)), Math.max(0, Math.min(this.i.dims.height, y))];
  private local(e: { clientX: number; clientY: number; currentTarget: Element }): Pt {
    const r = e.currentTarget.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Topmost item part under screen point `p`. The selected item wins ties. */
  hitTest(p: Pt): ItemHit | null {
    const { items, selectedId, toScreen } = this.i;
    const order = [...items].reverse().sort((x, y) => Number(y.a.id === selectedId) - Number(x.a.id === selectedId));
    for (const it of order) {
      const h = shapeUtil(it.placed)?.hitTest(it.placed, p, toScreen, { selected: it.a.id === selectedId });
      if (h) return { ...h, id: it.a.id };
    }
    return null;
  }

  onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const i = this.i;
    const sp = this.local(e);
    const cp = i.toContent(...sp);
    if (e.button === 1 || (e.button === 0 && (i.tool === "pan" || this.space.down))) {
      e.preventDefault();
      if (this.space.down) this.space.panned = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      i.pan.start(e);
      this.action = { kind: "pan" };
      return;
    }
    if (e.button !== 0 || !i.ready) return;
    if (i.playing) i.pause();

    const hit = this.hitTest(sp);
    const drawing = DRAWING.has(i.tool);
    // Shift/⌘/Ctrl-click adds to or removes from the selection.
    if ((e.shiftKey || e.metaKey || e.ctrlKey) && hit && !this.draft) return i.toggleSelect(hit.id);
    // Shape tools still edit the selected shape's handles; everything else selects/edits.
    const editHit = hit && (!drawing || (hit.id === i.selectedId && !this.draft)) ? hit : null;

    if (drawing && !editHit) {
      if (!i.canDraw()) return;
      if (i.tool === "box") {
        e.currentTarget.setPointerCapture(e.pointerId);
        this.action = { kind: "draw-box", a: this.clamp(cp), b: this.clamp(cp) };
      } else if (i.tool === "keypoint") {
        const [x, y] = this.clamp(cp);
        i.create("keypoint", { type: "keypoint", x, y });
      } else {
        const pts = this.draft ?? [];
        if (pts.length >= 3) {
          const [fx, fy] = i.toScreen(...pts[0]);
          if (Math.hypot(fx - sp[0], fy - sp[1]) <= CLOSE_RADIUS) return this.closePolygon(pts);
        }
        this.setDraft([...pts, this.clamp(cp)]);
      }
      return;
    }
    if (i.tool === "event" && !hit) return i.addEvent();
    if (!editHit) return i.select(null);
    i.select(editHit.id);
    const it = i.items.find((x) => x.a.id === editHit.id)!;
    if (!it.editable) return;
    const polygon = it.view.type === "polygon";
    if (polygon && editHit.part === "handle" && e.altKey) {
      const pts = shapeUtil(it.placed)!.handles(it.placed);
      if (pts.length > 3) i.commit(it.a.id, applyShape(it.a.geometry, i.frame, { points: pts.filter((_, k) => k !== editHit.index) }));
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (polygon && editHit.part === "edge") {
      // Insert a vertex on the edge and drag it.
      const pts = [...shapeUtil(it.placed)!.handles(it.placed)];
      pts.splice(editHit.index, 0, cp);
      const orig = this.place(applyShape(it.a.geometry, i.frame, { points: pts }));
      this.action = { kind: "edit", id: it.a.id, hit: { part: "handle", index: editHit.index }, start: cp, orig, live: orig };
    } else {
      this.action = { kind: "edit", id: it.a.id, hit: editHit, start: cp, orig: it.placed, live: null };
    }
    this.onChange();
  };

  private place(g: Geometry): Geometry {
    return g.type === "track" ? placeTrack(g, this.i.frame) : g;
  }

  onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const i = this.i;
    const act = this.action;
    const sp = this.local(e);
    const cp = i.toContent(...sp);
    if (act?.kind === "pan") return i.pan.move(e);
    if (act?.kind === "draw-box") {
      act.b = this.clamp(cp);
      return this.onChange();
    }
    if (act?.kind === "edit") {
      const dx = cp[0] - act.start[0], dy = cp[1] - act.start[1];
      const u = shapeUtil(act.orig)!;
      if (act.hit.part === "handle") {
        const [hx, hy] = u.handles(act.orig)[act.hit.index];
        act.live = u.applyHandle(act.orig, act.hit.index, [hx + dx, hy + dy]);
      } else act.live = u.translate(act.orig, dx, dy);
      return this.onChange();
    }
    if (this.draft) {
      this.cursor = this.clamp(cp);
      this.onChange();
    }
    // Hover cursor.
    const el = e.currentTarget;
    if (this.space.down || i.tool === "pan") el.style.cursor = "grab";
    else {
      const hit = this.hitTest(sp);
      const drawing = DRAWING.has(i.tool);
      if (hit && (!drawing || hit.id === i.selectedId)) {
        const it = i.items.find((x) => x.a.id === hit.id);
        el.style.cursor = !it?.editable
          ? "pointer"
          : hit.part === "handle"
            ? it.view.type === "box" ? HANDLE_CURSORS[hit.index] : "move"
            : hit.part === "edge" ? "copy" : "move";
      } else el.style.cursor = drawing || i.tool === "event" ? "crosshair" : "default";
    }
  };

  onPointerUp = () => {
    const act = this.action;
    this.action = null;
    if (!act) return;
    if (act.kind === "pan") this.i.pan.end();
    else if (act.kind === "draw-box") {
      const [x0, y0] = act.a, [x1, y1] = act.b;
      const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
      if (w > 3 && h > 3) this.i.create("box", { type: "box", x: Math.min(x0, x1), y: Math.min(y0, y1), w, h });
    } else if (act.kind === "edit" && act.live) {
      const g = unplace(act.live);
      // Per-frame shapes are rounded the way applyShape stores them; track keyframes already are.
      this.i.commit(act.id, g.type === "track" ? g : applyShape(g, this.i.frame, shapeData(g)));
    }
    this.onChange();
  };

  onDoubleClick = () => {
    const pts = this.draft;
    if (this.i.tool !== "polygon" || !pts) return;
    // The double-click's second press added a duplicate vertex; drop it, then close.
    const dup = pts.length > 1 && Math.hypot(pts[pts.length - 1][0] - pts[pts.length - 2][0], pts[pts.length - 1][1] - pts[pts.length - 2][1]) * this.i.scale < 4;
    this.closePolygon(dup ? pts.slice(0, -1) : pts);
  };

  // ---- drawing ----
  draw(ctx: CanvasRenderingContext2D) {
    const i = this.i;
    const act = this.action;
    const live = act?.kind === "edit" && act.live ? act : null;
    const aiColor = resolveToken("--prov-ai");
    for (const it of i.items) {
      const { a } = it;
      let view = it.view;
      if (live && live.id === a.id) view = (live.live!.type === "track" ? resolveTrack(live.live as TrackGeometry) : live.live) ?? view;
      const sel = i.selectedIds.has(a.id) || a.id === i.selectedId;
      const ai = a.provenance === "ai-suggested";
      ctx.save();
      if (it.occluded) ctx.globalAlpha = 0.75;
      drawShape(ctx, view, i.toScreen, {
        stroke: ai ? aiColor : resolveLabelColor(i.labels, a.label),
        fill: resolveLabelColor(i.labels, a.label, (sel ? 0.22 : 0.1) * i.opacity),
        lineWidth: sel ? 2.5 : 1.5,
        dash: it.occluded ? [3, 4] : ai ? [6, 4] : [],
      });
      ctx.restore();
      const handles = shapeUtil(view)!.handles(view).map(([x, y]) => i.toScreen(x, y));
      if (a.id === i.selectedId && it.editable && view.type !== "keypoint") drawHandles(ctx, handles);
      const anchor = view.type === "keypoint" ? [handles[0][0] + 8, handles[0][1] - 6] : handles.reduce((m, p) => (p[1] < m[1] ? p : m), handles[0]);
      const flags = (it.keyframe && a.geometry.type === "track" ? " ◆" : "") + (it.occluded ? " · occluded" : "") + (a.locked ? " · locked" : "");
      drawTag(ctx, anchor[0], anchor[1], `${it.tag}${flags}`, ai ? resolveToken("--prov-ai", 0.9) : resolveLabelColor(i.labels, a.label, 0.9));
    }
    const color = i.activeLabel ? resolveLabelColor(i.labels, i.activeLabel) : "#fff";
    if (act?.kind === "draw-box") drawDraft(ctx, color, i.toScreen, act.a, act.b);
    if (this.draft) drawDraft(ctx, color, i.toScreen, this.draft, this.cursor);
  }
}

/** In-progress shapes: a box being dragged (two corners) or a polygon being clicked out. */
function drawDraft(ctx: CanvasRenderingContext2D, color: string, toScreen: ToScreen, a: Pt | Pt[], b: Pt | null) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  if (!Array.isArray(a[0])) {
    const [x0, y0] = toScreen(...(a as Pt));
    const [x1, y1] = toScreen(...b!);
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else {
    const points = a as Pt[];
    const pts = points.map(([x, y]) => toScreen(x, y));
    if (b) pts.push(toScreen(...b));
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    points.forEach(([x, y], k) => {
      const [sx, sy] = toScreen(x, y);
      ctx.beginPath();
      ctx.arc(sx, sy, k === 0 ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.restore();
}
