import type { Geometry, Pt } from "@studio/contracts/types";
import type { Transform2D } from "./transform";

/**
 * Vertex editing for the overlay engine's select tool: which handles a geometry shows and
 * what dragging one does. Rings cover polygons with holes, every ring of a multipolygon,
 * splines, polylines and image-space measurements; boxes get 4 corners and ellipses 4
 * axis handles (rotation-aware).
 */
export type HandleRef = { kind: "ring"; ring: number; i: number } | { kind: "corner"; i: number } | { kind: "axis"; i: number };

/** Geometries with more vertices than this show no handles (they are edited by brush / eraser). */
export const MAX_HANDLES = 800;
/** Screen px within which a handle is grabbed. */
export const HANDLE_RADIUS = 7;

/** Vertex rings of an editable geometry; arrays are shared with `g` so they can be mutated in place. */
export function editRings(g: Geometry): { rings: Pt[][]; closed: boolean } | null {
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

export function cloneGeometry<G extends Geometry>(g: G): G {
  return structuredClone(g);
}

const boxCorners = (g: { x: number; y: number; w: number; h: number }): Pt[] => [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]];

/** Vertex / corner / axis handles of a geometry, in screen px. */
export function handlesOf(g: Geometry, v: Transform2D): { ref: HandleRef; s: Pt }[] {
  if (g.type === "box") return boxCorners(g).map((p, i) => ({ ref: { kind: "corner", i }, s: v.toScreen(...p) }));
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

/**
 * Drag handle `h` to image point `p`. `g` is the working copy (ring handles mutate it in
 * place and return a new identity so cached paths refresh); `base` is the geometry at
 * drag start (box corners resize against the opposite corner of the original).
 */
export function dragHandle(g: Geometry, base: Geometry, h: HandleRef, p: Pt): Geometry {
  if (h.kind === "ring") {
    const er = editRings(g);
    if (!er) return g;
    er.rings[h.ring][h.i] = p;
    return { ...g } as Geometry;
  }
  if (h.kind === "corner" && g.type === "box" && base.type === "box") {
    const o = boxCorners(base)[(h.i + 2) % 4];
    return { ...g, x: Math.min(o[0], p[0]), y: Math.min(o[1], p[1]), w: Math.abs(p[0] - o[0]), h: Math.abs(p[1] - o[1]) };
  }
  if (h.kind === "axis" && g.type === "ellipse") {
    const r = g.rotation ?? 0;
    const ux = h.i < 2 ? Math.cos(r) : -Math.sin(r), uy = h.i < 2 ? Math.sin(r) : Math.cos(r);
    const len = Math.max(1, Math.abs((p[0] - g.cx) * ux + (p[1] - g.cy) * uy));
    return h.i < 2 ? { ...g, rx: len } : { ...g, ry: len };
  }
  return g;
}

/** A copy of `g` with `p` inserted into ring `ring` before `index`, or null if it has no rings. */
export function insertVertex(g: Geometry, ring: number, index: number, p: Pt): Geometry | null {
  const out = cloneGeometry(g);
  const er = editRings(out);
  if (!er) return null;
  er.rings[ring].splice(index, 0, p);
  return out;
}

/** A copy of `g` without vertex `h`, or null when that would leave too few vertices. */
export function deleteVertex(g: Geometry, h: HandleRef): Geometry | null {
  if (h.kind !== "ring") return null;
  const out = cloneGeometry(g);
  const er = editRings(out);
  if (!er) return null;
  const ring = er.rings[h.ring];
  if (ring.length <= (er.closed ? 3 : 2)) return null;
  ring.splice(h.i, 1);
  return out;
}
