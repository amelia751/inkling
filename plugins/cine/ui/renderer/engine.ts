import { drawHandles } from "@studio/studio-renderers/overlay2d/draw";
import { distToSegment, pointInPolygon, polygonArea, rleDecode } from "@studio/studio-renderers/overlay2d/geometry";
import { shapeUtil } from "@studio/studio-renderers/overlay2d/shapes";
import type { Volume } from "@studio/studio-renderers/io/nifti";
import type { Annotation, Pt } from "@studio/plugin-contracts/types";
import { ring, type Cell, type ContourAnn, type ContourGeometry, type Structures } from "../model";

/**
 * Imperative core of the slice × frame renderer, free of React: the drag state machine's
 * types, hit-testing in voxel space, brush stamping and drawing one slice/frame with its
 * contours, masks, draft and cursor. The host (Host.tsx) owns state and calls in.
 */

export type Drag =
  | { kind: "pan" }
  | { kind: "wl"; x: number; y: number; lo: number; hi: number }
  | { kind: "vertex"; id: string; index: number; points: Pt[] }
  | { kind: "move"; id: string; start: Pt; points: Pt[]; origin: Pt[] }
  | { kind: "freehand"; path: Pt[] }
  /** Brush paints one layer (the active label); the eraser clears every editable mask on the slice/frame. */
  | { kind: "paint"; erase: boolean; layers: { id: string | null; label: string; buf: Uint8Array }[]; last: Pt };
export type PaintDrag = Extract<Drag, { kind: "paint" }>;

export const EMPTY_CELL: Cell = { contours: [], masks: [] };
export const round2 = (p: Pt): Pt => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
/** Dense samples per control-point segment, matching model.ring(). */
const SAMPLES = 12;

export function centroid(pts: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

/** Control-point index to insert at when clicking within `hitR` (voxels) of the outline, or -1. */
export function edgeInsertIndex(g: ContourGeometry, p: Pt, hitR: number): number {
  if (g.type === "polygon") {
    let best = -1, bestD = hitR;
    for (let i = 0; i < g.points.length; i++) {
      const { d } = distToSegment(p, g.points[i], g.points[(i + 1) % g.points.length]);
      if (d <= bestD) {
        bestD = d;
        best = i + 1;
      }
    }
    return best;
  }
  const dense = ring(g);
  let best = -1, bestD = hitR;
  for (let i = 0; i < dense.length; i++) {
    const { d } = distToSegment(p, dense[i], dense[(i + 1) % dense.length]);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best < 0 ? -1 : Math.floor(best / SAMPLES) + 1;
}

/** Topmost annotation under p: the smallest contour containing it (or whose edge is near), else a mask. */
export function pickAt(cell: Cell, p: Pt, hitR: number, visible: (a: Annotation) => boolean, nx: number, ny: number): Annotation | null {
  let best: ContourAnn | null = null, bestA = Infinity;
  for (const c of cell.contours.filter(visible)) {
    const r = ring(c.geometry);
    if (r.length < 3) continue;
    const near = r.some((q, i) => distToSegment(p, q, r[(i + 1) % r.length]).d <= hitR);
    if (!near && !pointInPolygon(p, r)) continue;
    const area = polygonArea(r);
    if (area < bestA) {
      bestA = area;
      best = c;
    }
  }
  if (best) return best;
  const i = Math.floor(p[0]), j = Math.floor(p[1]);
  if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
  for (const m of [...cell.masks].reverse().filter(visible)) {
    const buf = rleDecode(m.geometry.counts, nx * ny);
    if (buf[j * nx + i]) return m;
  }
  return null;
}

/** Vertex drag through the contour's ShapeUtil (kits/overlay2d), on 0.01-voxel precision. */
export function dragVertex(d: Extract<Drag, { kind: "vertex" }>, p: Pt): Pt[] {
  const g = { type: "polygon" as const, points: d.points };
  return shapeUtil(g)!.applyHandle(g, d.index, round2(p)).points;
}

/** Whole-contour move through its ShapeUtil. */
export function dragMove(d: Extract<Drag, { kind: "move" }>, p: Pt): Pt[] {
  const g = { type: "polygon" as const, points: d.origin };
  return shapeUtil(g)!.translate(g, p[0] - d.start[0], p[1] - d.start[1]).points.map(round2);
}

/**
 * Stamp a round brush along a → b (voxels) into the drag's layers. The brush paints the
 * first layer (optionally only inside the display window); the eraser clears every layer.
 */
export function stamp(dr: PaintDrag, a: Pt, b: Pt, o: { radius: number; cine: Volume; slice: number; frame: number; threshold: [number, number] | null }) {
  const [nx, ny, nz] = o.cine.dims;
  const r = o.radius;
  const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(1, Math.ceil(dist / Math.max(0.5, r / 2)));
  const baseOff = o.frame * nx * ny * nz + o.slice * nx * ny;
  for (let s = 0; s <= steps; s++) {
    const cx = a[0] + ((b[0] - a[0]) * s) / steps, cy = a[1] + ((b[1] - a[1]) * s) / steps;
    for (let j = Math.max(0, Math.floor(cy - r)); j <= Math.min(ny - 1, Math.ceil(cy + r)); j++) {
      for (let i = Math.max(0, Math.floor(cx - r)); i <= Math.min(nx - 1, Math.ceil(cx + r)); i++) {
        if ((i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 > r * r) continue;
        const p = j * nx + i;
        if (dr.erase) for (const l of dr.layers) l.buf[p] = 0;
        else {
          if (o.threshold) {
            const v = o.cine.data[baseOff + p];
            if (v < o.threshold[0] || v > o.threshold[1]) continue;
          }
          dr.layers[0].buf[p] = 1;
        }
      }
    }
  }
}

export interface Scene {
  size: { width: number; height: number };
  /** Screen position of voxel-space point. */
  vs: (p: Pt) => [number, number];
  /** Screen rectangle of the whole slice. */
  image: { x: number; y: number; w: number; h: number };
  smooth: boolean;
  base: HTMLCanvasElement;
  refLayer: HTMLCanvasElement | null;
  maskLayer: HTMLCanvasElement | null;
  overlayOpacity: number;
  outlineOnly: boolean;
  contours: ContourAnn[];
  structs: Structures;
  preview: { id: string; points: Pt[] } | null;
  selectedIds: string[];
  selectedId: string | null;
  editable: (a: Annotation) => boolean;
  /** Index of the vertex being dragged, else -1. */
  activeVertex: number;
  draft: Pt[];
  freehand: Pt[] | null;
  tool: string;
  activeLabel: string | null;
  hover: [number, number] | null;
  brushSize: number;
  color: (label: string, alpha?: number) => string;
  token: (name: string) => string;
}

/** Draw one slice/frame: image, reference outline, masks, contours (with handles), draft and brush cursor. */
export function drawScene(ctx: CanvasRenderingContext2D, s: Scene) {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, s.size.width, s.size.height);
  const { x: x0, y: y0, w, h } = s.image;
  ctx.imageSmoothingEnabled = s.smooth;
  ctx.drawImage(s.base, x0, y0, w, h);
  ctx.imageSmoothingEnabled = false;
  if (s.refLayer) {
    ctx.globalAlpha = 0.55 * s.overlayOpacity + 0.2;
    ctx.drawImage(s.refLayer, x0, y0, w, h);
    ctx.globalAlpha = 1;
  }
  if (s.maskLayer) ctx.drawImage(s.maskLayer, x0, y0, w, h);

  const toScreen = (x: number, y: number) => s.vs([x, y]);
  const lvs = s.contours.filter((c) => c.label === s.structs.lv);
  const aiColor = s.token("--prov-ai");
  for (const a of s.contours) {
    const pts = s.preview?.id === a.id ? s.preview.points : a.geometry.points;
    const g: ContourGeometry = { ...a.geometry, points: pts } as ContourGeometry;
    const outer = (s.preview?.id === a.id ? ring(g) : ring(a.geometry)).map(s.vs);
    if (outer.length < 3) continue;
    const isSel = s.selectedIds.includes(a.id);
    const isPrimary = a.id === s.selectedId;
    // A `myo` contour drawn around an `lv` contour is an outer border: fill the ring only.
    const holes = a.label === s.structs.myo ? lvs.filter((lv) => pointInPolygon(centroid(ring(lv.geometry)), ring(g))).map((lv) => ring(lv.geometry).map(s.vs)) : [];
    ctx.save();
    if (!s.outlineOnly) {
      ctx.beginPath();
      for (const r of [outer, ...holes]) {
        ctx.moveTo(r[0][0], r[0][1]);
        for (let i = 1; i < r.length; i++) ctx.lineTo(r[i][0], r[i][1]);
        ctx.closePath();
      }
      ctx.fillStyle = s.color(a.label, (isSel ? 0.3 : 0.18) * s.overlayOpacity);
      ctx.fill("evenodd");
    }
    const ai = a.provenance === "ai-suggested";
    const src = a.attributes?.source;
    ctx.strokeStyle = ai ? aiColor : s.color(a.label);
    ctx.lineWidth = isSel ? 2.5 : 1.5;
    ctx.setLineDash(ai ? [6, 4] : src === "interpolated" ? [5, 3] : src === "copied" ? [2, 3] : []);
    ctx.stroke(shapeUtil(g)!.path(g, toScreen));
    ctx.restore();
    if (isPrimary && s.editable(a)) drawHandles(ctx, pts.map(s.vs), s.activeVertex, 7);
  }

  // Draft (spline/polygon in progress) and freehand path.
  const drawOpen = (pts: Pt[], closed: boolean) => {
    if (!pts.length || !s.activeLabel) return;
    const sp = pts.map(s.vs);
    ctx.save();
    ctx.strokeStyle = s.color(s.activeLabel);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(sp[0][0], sp[0][1]);
    for (const [x, y] of sp.slice(1)) ctx.lineTo(x, y);
    if (closed) ctx.closePath();
    ctx.stroke();
    ctx.restore();
  };
  if (s.draft.length) {
    const smoothDraft = s.tool === "spline" && s.draft.length >= 3 ? ring({ type: "spline", points: s.draft }) : s.draft;
    drawOpen(smoothDraft, s.tool === "spline" && s.draft.length >= 3);
    ctx.save();
    for (const [i, [x, y]] of s.draft.map(s.vs).entries()) {
      ctx.fillStyle = i === 0 ? s.token("--primary") : "#fff";
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  if (s.freehand) drawOpen(s.freehand, false);

  // Brush cursor.
  if (s.hover && (s.tool === "brush" || s.tool === "eraser")) {
    ctx.save();
    ctx.strokeStyle = s.tool === "eraser" ? "rgba(255,255,255,0.8)" : s.activeLabel ? s.color(s.activeLabel) : "#fff";
    ctx.setLineDash(s.tool === "eraser" ? [3, 3] : []);
    ctx.beginPath();
    ctx.arc(s.hover[0], s.hover[1], s.brushSize / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}
