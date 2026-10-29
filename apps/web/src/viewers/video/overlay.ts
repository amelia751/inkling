import { resolveLabelColor, resolveToken } from "@/lib/labels";
import type { Annotation, Pt } from "@/types";
import { drawHandles, drawTag } from "@/viewers/shared/draw";
import { distToSegment, hitEdge, hitVertex, pointInPolygon } from "@/viewers/shared/geometry";
import type { Box, FrameShape } from "./tracks";

/** One annotation as it appears on the current frame. */
export interface Renderable {
  a: Annotation;
  shape: FrameShape;
  /** "#3 polyp" for tracks, "polyp" for per-frame shapes. */
  tag: string;
  editable: boolean;
}

export type ToScreen = (x: number, y: number) => [number, number];

export type Hit = { id: string; part: "body" | "handle" | "vertex" | "edge"; index: number };

const HANDLE_RADIUS = 7;

/** Box handles in screen space: nw, n, ne, e, se, s, sw, w. */
export function boxHandles(b: Box, toScreen: ToScreen): Pt[] {
  const [x0, y0] = toScreen(b[0], b[1]);
  const [x1, y1] = toScreen(b[0] + b[2], b[1] + b[3]);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return [[x0, y0], [mx, y0], [x1, y0], [x1, my], [x1, y1], [mx, y1], [x0, y1], [x0, my]];
}

export const HANDLE_CURSORS = ["nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "nwse-resize", "ns-resize", "nesw-resize", "ew-resize"];

/** Resize a box by dragging handle `h` by (dx, dy) content units; result is normalised. */
export function resizeBox(b: Box, h: number, dx: number, dy: number): Box {
  let x0 = b[0], y0 = b[1], x1 = b[0] + b[2], y1 = b[1] + b[3];
  if (h === 0 || h === 6 || h === 7) x0 += dx;
  if (h === 2 || h === 3 || h === 4) x1 += dx;
  if (h === 0 || h === 1 || h === 2) y0 += dy;
  if (h === 4 || h === 5 || h === 6) y1 += dy;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
}

export function translateShape(s: FrameShape, dx: number, dy: number): { box?: Box; points?: Pt[] } {
  if (s.box) return { box: [s.box[0] + dx, s.box[1] + dy, s.box[2], s.box[3]] };
  return { points: s.points!.map(([x, y]) => [x + dx, y + dy] as Pt) };
}

/** Topmost annotation part under screen point `p`. The selected annotation wins ties. */
export function hitTest(list: Renderable[], p: Pt, toScreen: ToScreen, selectedId: string | null): Hit | null {
  const order = [...list].reverse().sort((x, y) => Number(y.a.id === selectedId) - Number(x.a.id === selectedId));
  for (const r of order) {
    const sel = r.a.id === selectedId;
    const s = r.shape;
    if (s.box) {
      if (sel) {
        const h = hitVertex(p, boxHandles(s.box, toScreen), HANDLE_RADIUS);
        if (h >= 0) return { id: r.a.id, part: "handle", index: h };
      }
      const [x0, y0] = toScreen(s.box[0], s.box[1]);
      const [x1, y1] = toScreen(s.box[0] + s.box[2], s.box[1] + s.box[3]);
      if (p[0] >= x0 - 3 && p[0] <= x1 + 3 && p[1] >= y0 - 3 && p[1] <= y1 + 3) return { id: r.a.id, part: "body", index: -1 };
      continue;
    }
    const pts = s.points!.map(([x, y]) => toScreen(x, y));
    if (s.kind === "keypoint") {
      const v = hitVertex(p, pts, 9);
      if (v >= 0) return { id: r.a.id, part: sel ? "vertex" : "body", index: v };
      continue;
    }
    if (sel) {
      const v = hitVertex(p, pts, HANDLE_RADIUS);
      if (v >= 0) return { id: r.a.id, part: "vertex", index: v };
      const e = hitEdge(p, pts, 5);
      if (e >= 0) return { id: r.a.id, part: "edge", index: e };
    }
    if (pointInPolygon(p, pts) || nearRing(p, pts, 4)) return { id: r.a.id, part: "body", index: -1 };
  }
  return null;
}

function nearRing(p: Pt, pts: Pt[], r: number) {
  for (let i = 0; i < pts.length; i++) if (distToSegment(p, pts[i], pts[(i + 1) % pts.length]).d <= r) return true;
  return false;
}

interface DrawOptions {
  labels: string[];
  /** Primary selection: gets edit handles. */
  selectedId: string | null;
  /** Every selected annotation (highlighted). */
  selectedIds: ReadonlySet<string>;
  opacity: number;
  hoverId?: string | null;
}

export function drawRenderables(ctx: CanvasRenderingContext2D, list: Renderable[], toScreen: ToScreen, o: DrawOptions) {
  const aiColor = resolveToken("--prov-ai");
  for (const r of list) {
    const { a, shape: s } = r;
    const sel = o.selectedIds.has(a.id) || a.id === o.selectedId;
    const primary = a.id === o.selectedId;
    const ai = a.provenance === "ai-suggested";
    const stroke = ai ? aiColor : resolveLabelColor(o.labels, a.label);
    ctx.save();
    ctx.lineWidth = sel ? 2.5 : a.id === o.hoverId ? 2 : 1.5;
    ctx.strokeStyle = stroke;
    ctx.fillStyle = resolveLabelColor(o.labels, a.label, (sel ? 0.22 : 0.1) * o.opacity);
    ctx.setLineDash(s.occluded ? [3, 4] : ai ? [6, 4] : []);
    if (s.occluded) ctx.globalAlpha = 0.75;
    let anchor: [number, number];
    if (s.box) {
      const [x0, y0] = toScreen(s.box[0], s.box[1]);
      const [x1, y1] = toScreen(s.box[0] + s.box[2], s.box[1] + s.box[3]);
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      anchor = [x0, y0];
      ctx.restore();
      if (primary && r.editable) drawHandles(ctx, boxHandles(s.box, toScreen));
    } else if (s.kind === "keypoint") {
      const pts = s.points!.map(([x, y]) => toScreen(x, y));
      for (const [x, y] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, sel ? 6 : 5, 0, Math.PI * 2);
        ctx.fillStyle = resolveLabelColor(o.labels, a.label, 0.9);
        ctx.fill();
        ctx.lineWidth = sel ? 2.5 : 1.5;
        ctx.strokeStyle = sel ? "#fff" : "rgba(0,0,0,0.6)";
        ctx.stroke();
      }
      anchor = [pts[0][0] + 8, pts[0][1] - 6];
      ctx.restore();
    } else {
      const pts = s.points!.map(([x, y]) => toScreen(x, y));
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      anchor = pts.reduce((m, p) => (p[1] < m[1] ? p : m), pts[0]);
      ctx.restore();
      if (primary && r.editable) drawHandles(ctx, pts);
    }
    const flags = (s.keyframe && a.geometry.type === "track" ? " ◆" : "") + (s.occluded ? " · occluded" : "") + (a.locked ? " · locked" : "");
    drawTag(ctx, anchor[0], anchor[1], `${r.tag}${flags}`, ai ? resolveToken("--prov-ai", 0.9) : resolveLabelColor(o.labels, a.label, 0.9));
  }
}

/** In-progress shapes: a box being dragged or a polygon being clicked out. */
export function drawDraft(
  ctx: CanvasRenderingContext2D,
  color: string,
  draft: { kind: "box"; a: Pt; b: Pt } | { kind: "polygon"; points: Pt[]; cursor: Pt | null },
  toScreen: ToScreen,
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  if (draft.kind === "box") {
    const [x0, y0] = toScreen(...draft.a);
    const [x1, y1] = toScreen(...draft.b);
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else {
    const pts = draft.points.map(([x, y]) => toScreen(x, y));
    if (draft.cursor) pts.push(toScreen(...draft.cursor));
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    draft.points.forEach(([x, y], i) => {
      const [sx, sy] = toScreen(x, y);
      ctx.beginPath();
      ctx.arc(sx, sy, i === 0 ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  ctx.restore();
}
