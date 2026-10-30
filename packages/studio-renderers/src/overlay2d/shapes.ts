import type { Geometry, Pt } from "@studio/plugin-contracts/types";
import { bounds as ptsBounds, catmullRomClosed, distToSegment, ellipsePoints, hitEdge, hitVertex, pointInPolygon } from "./geometry";

/**
 * One ShapeUtil per core 2D geometry (tldraw `ShapeUtil` style): pure functions over a
 * geometry in item (image) coordinates, plus a transform to screen for hit-testing and
 * drawing. Renderers and tools never switch on geometry types for these operations;
 * they ask `shapeUtil(g)`.
 *
 * Handles are addressed by a stable index per shape: box/ellipse use 8 resize handles
 * (nw, n, ne, e, se, s, sw, w), vertex shapes use one handle per vertex.
 */

export type ToScreen = (x: number, y: number) => Pt;
export type BBox = [minX: number, minY: number, maxX: number, maxY: number];

export type Hit = { part: "body" } | { part: "handle"; index: number } | { part: "edge"; index: number };

export interface DrawStyle {
  stroke: string;
  fill?: string;
  lineWidth?: number;
  dash?: number[];
}

export interface ShapeUtil<G extends Geometry = Geometry> {
  type: G["type"];
  bounds(g: G): BBox;
  /** Handle positions in item coordinates. */
  handles(g: G): Pt[];
  /** Move handle `index` to item point `p` (Shift-style constraints are the tool's job). */
  applyHandle(g: G, index: number, p: Pt): G;
  translate(g: G, dx: number, dy: number): G;
  /** Topmost part under screen point `p`, within `tol` screen pixels. `selected` enables handles/edges. */
  hitTest(g: G, p: Pt, toScreen: ToScreen, opts?: { tol?: number; selected?: boolean }): Hit | null;
  /** Trace the outline into a canvas path in screen space. */
  path(g: G, toScreen: ToScreen): Path2D;
  /** Closed shapes get fills. */
  closed: boolean;
}

const HANDLE_TOL = 7;
type Of<T extends Geometry["type"]> = Extract<Geometry, { type: T }>;

const moveAll = (pts: Pt[], dx: number, dy: number) => pts.map(([x, y]) => [x + dx, y + dy] as Pt);
const bbox = (pts: Pt[]): BBox => {
  const b = ptsBounds(pts);
  return [b.minX, b.minY, b.maxX, b.maxY];
};
const polyPath = (pts: Pt[], toScreen: ToScreen, closed: boolean, path = new Path2D()) => {
  pts.forEach(([x, y], i) => {
    const [sx, sy] = toScreen(x, y);
    if (i) path.lineTo(sx, sy);
    else path.moveTo(sx, sy);
  });
  if (closed && pts.length) path.closePath();
  return path;
};
const nearRing = (p: Pt, pts: Pt[], tol: number, closed: boolean) => {
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) if (distToSegment(p, pts[i], pts[(i + 1) % pts.length]).d <= tol) return true;
  return false;
};

/** Eight resize handles of an axis-aligned rectangle. */
function rectHandles(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return [[x0, y0], [mx, y0], [x1, y0], [x1, my], [x1, y1], [mx, y1], [x0, y1], [x0, my]];
}
/** Drag handle `h` of [x0,y0,x1,y1] to p; result normalised (min/max swapped as needed). */
function resizeRect([x0, y0, x1, y1]: BBox, h: number, [px, py]: Pt): BBox {
  if (h === 0 || h === 6 || h === 7) x0 = px;
  if (h === 2 || h === 3 || h === 4) x1 = px;
  if (h === 0 || h === 1 || h === 2) y0 = py;
  if (h === 4 || h === 5 || h === 6) y1 = py;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

export const HANDLE_CURSORS = ["nwse-resize", "ns-resize", "nesw-resize", "ew-resize", "nwse-resize", "ns-resize", "nesw-resize", "ew-resize"];

const box: ShapeUtil<Of<"box">> = {
  type: "box",
  closed: true,
  bounds: (g) => [g.x, g.y, g.x + g.w, g.y + g.h],
  handles: (g) => rectHandles(g.x, g.y, g.x + g.w, g.y + g.h),
  applyHandle: (g, i, p) => {
    const [x0, y0, x1, y1] = resizeRect([g.x, g.y, g.x + g.w, g.y + g.h], i, p);
    return { ...g, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  },
  translate: (g, dx, dy) => ({ ...g, x: g.x + dx, y: g.y + dy }),
  hitTest(g, p, toScreen, { tol = 3, selected = false } = {}) {
    if (selected) {
      const h = hitVertex(p, box.handles(g).map(([x, y]) => toScreen(x, y)), HANDLE_TOL);
      if (h >= 0) return { part: "handle", index: h };
    }
    const [x0, y0] = toScreen(g.x, g.y), [x1, y1] = toScreen(g.x + g.w, g.y + g.h);
    const [lx, hx] = [Math.min(x0, x1), Math.max(x0, x1)], [ly, hy] = [Math.min(y0, y1), Math.max(y0, y1)];
    return p[0] >= lx - tol && p[0] <= hx + tol && p[1] >= ly - tol && p[1] <= hy + tol ? { part: "body" } : null;
  },
  path: (g, toScreen) => polyPath([[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]], toScreen, true),
};

const ellipse: ShapeUtil<Of<"ellipse">> = {
  type: "ellipse",
  closed: true,
  bounds: (g) => [g.cx - g.rx, g.cy - g.ry, g.cx + g.rx, g.cy + g.ry],
  handles: (g) => rectHandles(g.cx - g.rx, g.cy - g.ry, g.cx + g.rx, g.cy + g.ry),
  applyHandle: (g, i, p) => {
    const [x0, y0, x1, y1] = resizeRect(ellipse.bounds(g), i, p);
    return { ...g, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: (x1 - x0) / 2, ry: (y1 - y0) / 2 };
  },
  translate: (g, dx, dy) => ({ ...g, cx: g.cx + dx, cy: g.cy + dy }),
  hitTest(g, p, toScreen, { tol = 3, selected = false } = {}) {
    if (selected) {
      const h = hitVertex(p, ellipse.handles(g).map(([x, y]) => toScreen(x, y)), HANDLE_TOL);
      if (h >= 0) return { part: "handle", index: h };
    }
    const ring = ellipsePoints(g.cx, g.cy, g.rx, g.ry, g.rotation ?? 0, 48).map(([x, y]) => toScreen(x, y));
    return pointInPolygon(p, ring) || nearRing(p, ring, tol, true) ? { part: "body" } : null;
  },
  path: (g, toScreen) => polyPath(ellipsePoints(g.cx, g.cy, g.rx, g.ry, g.rotation ?? 0, 64), toScreen, true),
};

type VertexGeometry = Of<"polygon"> | Of<"polyline"> | Of<"spline">;

/** Shared behaviour of vertex-list shapes (polygon, polyline, spline). */
function vertexShape(type: VertexGeometry["type"], closed: boolean, outline: (g: VertexGeometry) => Pt[]): ShapeUtil<VertexGeometry> {
  const util: ShapeUtil<VertexGeometry> = {
    type,
    closed,
    bounds: (g) => bbox(outline(g)),
    handles: (g) => g.points,
    applyHandle: (g, i, p) => ({ ...g, points: g.points.map((q, j) => (j === i ? p : q)) }),
    translate: (g, dx, dy) => {
      const out = { ...g, points: moveAll(g.points, dx, dy) } as VertexGeometry;
      if ("holes" in g && g.holes) (out as Of<"polygon">).holes = g.holes.map((h) => moveAll(h, dx, dy));
      return out;
    },
    hitTest(g, p, toScreen, { tol = 4, selected = false } = {}) {
      const ctrl = g.points.map(([x, y]) => toScreen(x, y));
      if (selected) {
        const v = hitVertex(p, ctrl, HANDLE_TOL);
        if (v >= 0) return { part: "handle", index: v };
        const e = hitEdge(p, ctrl, 5, closed);
        if (e >= 0) return { part: "edge", index: e };
      }
      const ring = outline(g).map(([x, y]) => toScreen(x, y));
      if (closed && pointInPolygon(p, ring)) return { part: "body" };
      return nearRing(p, ring, tol, closed) ? { part: "body" } : null;
    },
    path: (g, toScreen) => {
      const path = polyPath(outline(g), toScreen, closed);
      if ("holes" in g) for (const h of g.holes ?? []) polyPath(h, toScreen, true, path);
      return path;
    },
  };
  return util;
}

const polygon = vertexShape("polygon", true, (g) => g.points);
const polyline = vertexShape("polyline", false, (g) => g.points);
const spline = vertexShape("spline", true, (g) => catmullRomClosed(g.points));

const multipolygon: ShapeUtil<Of<"multipolygon">> = {
  type: "multipolygon",
  closed: true,
  bounds: (g) => bbox(g.polygons.flatMap((rings) => rings[0] ?? [])),
  // Regions are edited by brush / eraser, not by dragging vertices.
  handles: () => [],
  applyHandle: (g) => g,
  translate: (g, dx, dy) => ({ ...g, polygons: g.polygons.map((rings) => rings.map((r) => moveAll(r, dx, dy))) }),
  hitTest(g, p, toScreen, { tol = 4 } = {}) {
    for (const [outer, ...holes] of g.polygons) {
      const o = outer.map(([x, y]) => toScreen(x, y));
      if (pointInPolygon(p, o) && !holes.some((h) => pointInPolygon(p, h.map(([x, y]) => toScreen(x, y))))) return { part: "body" };
      if (nearRing(p, o, tol, true)) return { part: "body" };
    }
    return null;
  },
  path: (g, toScreen) => {
    const path = new Path2D();
    for (const rings of g.polygons) for (const r of rings) polyPath(r, toScreen, true, path);
    return path;
  },
};

const keypoint: ShapeUtil<Of<"keypoint">> = {
  type: "keypoint",
  closed: false,
  bounds: (g) => [g.x, g.y, g.x, g.y],
  handles: (g) => [[g.x, g.y]],
  applyHandle: (g, _i, [x, y]) => ({ ...g, x, y }),
  translate: (g, dx, dy) => ({ ...g, x: g.x + dx, y: g.y + dy }),
  hitTest(g, p, toScreen, { tol = 9, selected = false } = {}) {
    const [sx, sy] = toScreen(g.x, g.y);
    if (Math.hypot(p[0] - sx, p[1] - sy) > tol) return null;
    return selected ? { part: "handle", index: 0 } : { part: "body" };
  },
  path: (g, toScreen) => {
    const [sx, sy] = toScreen(g.x, g.y);
    const path = new Path2D();
    path.arc(sx, sy, 4, 0, Math.PI * 2);
    return path;
  },
};

const UTILS: Record<string, ShapeUtil> = Object.fromEntries(
  [box, ellipse, polygon, polyline, spline, multipolygon, keypoint].map((u) => [u.type, u as unknown as ShapeUtil]),
);

/** The ShapeUtil for a geometry, or undefined for non-planar types (span, mask, class…). */
export function shapeUtil<G extends Geometry>(g: G): ShapeUtil<G> | undefined {
  return UTILS[g.type] as ShapeUtil<G> | undefined;
}

/** Register a ShapeUtil for a module geometry (e.g. a video track resolved at the playhead). */
export function registerShapeUtil(util: ShapeUtil): void {
  UTILS[util.type] = util;
}

/** Stroke (and fill, for closed shapes) a geometry in screen space. */
export function drawShape(ctx: CanvasRenderingContext2D, g: Geometry, toScreen: ToScreen, style: DrawStyle): void {
  const u = shapeUtil(g);
  if (!u) return;
  const path = u.path(g, toScreen);
  ctx.save();
  ctx.lineWidth = style.lineWidth ?? 1.5;
  ctx.strokeStyle = style.stroke;
  ctx.setLineDash(style.dash ?? []);
  if (u.closed && style.fill) {
    ctx.fillStyle = style.fill;
    ctx.fill(path, "evenodd");
  }
  if (g.type === "keypoint") {
    ctx.fillStyle = style.stroke;
    ctx.fill(path);
  }
  ctx.stroke(path);
  ctx.restore();
}
