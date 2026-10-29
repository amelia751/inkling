import { difference, union, type Geom } from "polyclip-ts";
import simplifyPath from "simplify-js";
import type { Geometry, Pt } from "@/types";
import { ellipsePoints, pathLength, pointInPolygon, rasterizePolygon, signedArea } from "@/kits/overlay2d/geometry";

/** [outer, ...holes] per polygon, level-0 image pixels. Same shape as `multipolygon.polygons`. */
export type Region = Pt[][][];
export type BBox = [number, number, number, number];

const MAX_MASK = 4096;
const REGION_TYPES = new Set(["polygon", "multipolygon", "box", "ellipse"]);

export function isRegion(g: Geometry): boolean {
  return REGION_TYPES.has(g.type);
}

/** Area-bearing geometry as a multipolygon (box and ellipse are converted to rings). */
export function regionOf(g: Geometry): Region | null {
  switch (g.type) {
    case "polygon":
      return [[g.points, ...(g.holes ?? [])]];
    case "multipolygon":
      return g.polygons;
    case "box":
      return [[[[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]]]];
    case "ellipse":
      return [[ellipsePoints(g.cx, g.cy, g.rx, g.ry, g.rotation ?? 0, 96)]];
    default:
      return null;
  }
}

/** Store form of a region: `polygon` (with holes) when it is one piece, else `multipolygon`; null when empty. */
export function geometryFromRegion(region: Region): Geometry | null {
  const parts = region.filter((p) => p[0] && p[0].length >= 3);
  if (!parts.length) return null;
  const round = (r: Pt[]) => r.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as Pt);
  if (parts.length === 1) {
    const [outer, ...holes] = parts[0];
    return holes.length ? { type: "polygon", points: round(outer), holes: holes.map(round) } : { type: "polygon", points: round(outer) };
  }
  return { type: "multipolygon", polygons: parts.map((p) => p.map(round)) };
}

export function regionArea(region: Region): number {
  let s = 0;
  for (const [outer, ...holes] of region) {
    s += Math.abs(signedArea(outer));
    for (const h of holes) s -= Math.abs(signedArea(h));
  }
  return Math.max(0, s);
}

/** Total boundary length, holes included (QuPath convention). */
export function regionPerimeter(region: Region): number {
  let s = 0;
  for (const poly of region) for (const ring of poly) s += pathLength(ring, true);
  return s;
}

export function pointInRegion(p: Pt, region: Region): boolean {
  for (const [outer, ...holes] of region) {
    if (pointInPolygon(p, outer) && !holes.some((h) => pointInPolygon(p, h))) return true;
  }
  return false;
}

export function ringsBounds(rings: Iterable<Pt[]>): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings)
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  return [minX, minY, maxX, maxY];
}

/** Image-space bounding box of any geometry this viewer draws, or null. */
export function geometryBounds(g: Geometry): BBox | null {
  switch (g.type) {
    case "mark":
    case "keypoint":
      return [g.x, g.y, g.x, g.y];
    case "box":
      return [Math.min(g.x, g.x + g.w), Math.min(g.y, g.y + g.h), Math.max(g.x, g.x + g.w), Math.max(g.y, g.y + g.h)];
    case "ellipse": {
      const r = Math.max(g.rx, g.ry);
      return [g.cx - r, g.cy - r, g.cx + r, g.cy + r];
    }
    case "polygon":
    case "polyline":
    case "spline":
      return g.points.length ? ringsBounds([g.points]) : null;
    case "multipolygon":
      return g.polygons.length ? ringsBounds(g.polygons.map((p) => p[0])) : null;
    case "measurement":
      return g.space === "image" && g.points.length ? ringsBounds([g.points as Pt[]]) : null;
    default:
      return null;
  }
}

const shift = (r: Pt[], dx: number, dy: number) => r.map(([x, y]) => [x + dx, y + dy] as Pt);

export function translateGeometry(g: Geometry, dx: number, dy: number): Geometry {
  switch (g.type) {
    case "mark":
    case "keypoint":
      return { ...g, x: g.x + dx, y: g.y + dy };
    case "box":
      return { ...g, x: g.x + dx, y: g.y + dy };
    case "ellipse":
      return { ...g, cx: g.cx + dx, cy: g.cy + dy };
    case "polygon":
      return { ...g, points: shift(g.points, dx, dy), ...(g.holes ? { holes: g.holes.map((h) => shift(h, dx, dy)) } : {}) };
    case "polyline":
    case "spline":
      return { ...g, points: shift(g.points, dx, dy) };
    case "multipolygon":
      return { ...g, polygons: g.polygons.map((p) => p.map((r) => shift(r, dx, dy))) };
    case "measurement":
      return { ...g, points: g.points.map(([x, y]) => [x + dx, y + dy]) };
    default:
      return g;
  }
}

// ---- Boolean operations (polyclip-ts) ----

function fromClip(mp: Pt[][][]): Region {
  return mp
    .map((poly) => poly.map((ring) => (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring)))
    .filter((poly) => poly[0]?.length >= 3);
}

/** Last boolean-op path taken (diagnostics/tests): exact polyclip, snapped polyclip, or raster fallback. */
export let lastBooleanPath: "exact" | "snapped" | "raster" | "none" = "none";

type ClipOp = typeof union;

function tryClip(op: ClipOp, a: Region, b: Region): Region | null {
  try {
    return fromClip(op(a as Geom, b as Geom));
  } catch {
    return null;
  }
}

/** Quarter-pixel snap and duplicate removal: resolves most near-degenerate inputs. */
function snap(r: Region): Region {
  return r
    .map((poly) =>
      poly
        .map((ring) => {
          const out: Pt[] = [];
          for (const [x, y] of ring) {
            const q: Pt = [Math.round(x * 4) / 4, Math.round(y * 4) / 4];
            const last = out[out.length - 1];
            if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
          }
          if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
          return out;
        })
        .filter((ring) => ring.length >= 3),
    )
    .filter((poly) => poly.length && poly[0].length >= 3);
}

/**
 * Raster boolean at `k` mask px per image px (screen resolution), traced back to polygons.
 * Always succeeds; precision is what the expert sees on screen.
 */
function rasterBoolean(a: Region, b: Region, op: "add" | "subtract", k: number): Region {
  const all = op === "add" ? [...a, ...b] : a;
  const [x0, y0, x1, y1] = ringsBounds(all.map((p) => p[0]));
  const span = Math.max(x1 - x0, y1 - y0, 1);
  const kk = Math.min(k, MAX_MASK / (span + 4 / k));
  const ox = x0 - 2 / kk, oy = y0 - 2 / kk;
  const w = Math.ceil((x1 - x0) * kk) + 4, h = Math.ceil((y1 - y0) * kk) + 4;
  const toMask = (r: Region) => r.flatMap((poly) => poly.map((ring) => ring.map(([x, y]) => [(x - ox) * kk, (y - oy) * kk] as Pt)));
  const ma = rasterizePolygon(toMask(a), w, h);
  const mb = rasterizePolygon(toMask(b), w, h);
  for (let i = 0; i < ma.length; i++) ma[i] = op === "add" ? ma[i] | mb[i] : ma[i] & (mb[i] ^ 1);
  return maskToRegion(ma, w, h, ox, oy, kk, 0.6);
}

function boolean(op: "add" | "subtract", a: Region, b: Region, k: number): Region {
  const fn = op === "add" ? union : difference;
  let r = tryClip(fn, a, b);
  if (r) {
    lastBooleanPath = "exact";
    return r;
  }
  r = tryClip(fn, snap(a), snap(b));
  if (r) {
    lastBooleanPath = "snapped";
    return r;
  }
  console.warn(`[pathology] polygon ${op} failed on degenerate input; using the raster fallback`);
  lastBooleanPath = "raster";
  return rasterBoolean(a, b, op, k);
}

/** Union; `k` (screen px per image px) is the resolution of the raster fallback. */
export function unionRegions(a: Region, b: Region, k = 1): Region {
  if (!a.length) return b;
  if (!b.length) return a;
  return boolean("add", a, b, k);
}

export function subtractRegion(a: Region, b: Region, k = 1): Region {
  if (!a.length || !b.length) return a;
  return boolean("subtract", a, b, k);
}

export function bboxOverlap(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// ---- Raster ⇄ vector ----

/** Ramer–Douglas–Peucker on a closed ring. */
export function simplifyRing(ring: Pt[], tol: number): Pt[] {
  if (ring.length <= 4 || tol <= 0) return ring;
  const pts = simplifyPath([...ring, ring[0]].map(([x, y]) => ({ x, y })), tol, false);
  pts.pop();
  return pts.length >= 3 ? pts.map((p) => [p.x, p.y] as Pt) : ring;
}

/**
 * Trace every boundary of a binary mask along pixel edges (crack following). Rings are
 * returned in mask-corner coordinates with foreground on the right of travel, so outer
 * rings have positive signed area and holes negative. At diagonal saddles the walk turns
 * right, i.e. foreground is 4-connected (matches the 4-connected wand fill).
 */
export function traceMask(mask: Uint8Array, w: number, h: number): Pt[][] {
  const W = w + 1;
  const next = new Int32Array(W * (h + 1)).fill(-1);
  const extra = new Map<number, number>();
  const add = (from: number, to: number) => {
    if (next[from] === -1) next[from] = to;
    else extra.set(from, to);
  };
  const fg = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] !== 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const tl = y * W + x, tr = tl + 1, bl = tl + W, br = bl + 1;
      if (!fg(x, y - 1)) add(tl, tr);
      if (!fg(x + 1, y)) add(tr, br);
      if (!fg(x, y + 1)) add(br, bl);
      if (!fg(x - 1, y)) add(bl, tl);
    }
  }
  const take = (v: number, dx: number, dy: number): number => {
    const a = next[v];
    const b = extra.get(v);
    if (b === undefined) {
      next[v] = -1;
      return a;
    }
    extra.delete(v);
    // Prefer the right turn relative to the incoming direction.
    const rx = -dy, ry = dx;
    const ax = (a % W) - (v % W), ay = Math.floor(a / W) - Math.floor(v / W);
    if (ax === rx && ay === ry) {
      next[v] = b;
      return a;
    }
    return b;
  };
  const rings: Pt[][] = [];
  const traceFrom = (start: number) => {
    const ring: Pt[] = [];
    let cur = start, dx = 0, dy = 0, guard = 0;
    do {
      const nxt = take(cur, dx, dy);
      if (nxt < 0) break;
      const ndx = (nxt % W) - (cur % W), ndy = Math.floor(nxt / W) - Math.floor(cur / W);
      if (ndx !== dx || ndy !== dy) ring.push([cur % W, Math.floor(cur / W)]);
      dx = ndx;
      dy = ndy;
      cur = nxt;
    } while (cur !== start && ++guard < 50_000_000);
    if (ring.length >= 3) rings.push(ring);
  };
  for (let v = 0; v < next.length; v++) if (next[v] !== -1 && !extra.has(v)) traceFrom(v);
  for (let v = 0; v < next.length; v++) if (next[v] !== -1) traceFrom(v);
  return rings;
}

/**
 * Mask → region in image coordinates. `k` is mask pixels per image pixel, `ox/oy` the
 * image position of the mask origin. Rings smaller than `minArea` mask px² are dropped,
 * then the staircase is smoothed with RDP at `tol` mask px.
 */
export function maskToRegion(mask: Uint8Array, w: number, h: number, ox: number, oy: number, k: number, tol = 0.75, minArea = 6, minHoleArea = minArea): Region {
  const rings = traceMask(mask, w, h)
    .map((r) => ({ r: simplifyRing(r, tol), area: signedArea(r) }))
    .filter((x) => (x.area > 0 ? x.area >= minArea : -x.area >= minHoleArea));
  const outers = rings.filter((x) => x.area > 0).sort((a, b) => a.area - b.area);
  const holes = rings.filter((x) => x.area < 0);
  const polys: Pt[][][] = outers.map((o) => [o.r]);
  for (const hole of holes) {
    const probe = hole.r[0];
    // Smallest outer containing the hole (a hole vertex never lies on its own outer).
    const i = outers.findIndex((o) => pointInPolygon([probe[0] + 0.25, probe[1] + 0.25], o.r) || pointInPolygon(probe, o.r));
    if (i >= 0) polys[i].push(hole.r);
  }
  const toImg = (r: Pt[]) => r.map(([x, y]) => [ox + x / k, oy + y / k] as Pt);
  return polys.map((p) => p.map(toImg));
}

function scratchCanvas(w: number, h: number): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true })!;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c.getContext("2d", { willReadFrequently: true })!;
}

/**
 * Rasterise a round-capped stroke (the union of discs of `radius` along `points`, image
 * px) at `k` mask px per image px and trace it back to a region. The mask resolution is
 * the screen resolution, so the result is as precise as what the expert saw.
 */
export function strokeToRegion(points: Pt[], radius: number, k: number): Region {
  if (!points.length) return [];
  const [x0, y0, x1, y1] = ringsBounds([points]);
  const pad = radius + 2 / k;
  let kk = k;
  const span = Math.max(x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
  if (span * kk > MAX_MASK) kk = MAX_MASK / span;
  const ox = x0 - pad, oy = y0 - pad;
  const w = Math.max(1, Math.ceil((x1 - x0 + 2 * pad) * kk));
  const h = Math.max(1, Math.ceil((y1 - y0 + 2 * pad) * kk));
  const ctx = scratchCanvas(w, h);
  ctx.fillStyle = ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2 * radius * kk;
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo((x - ox) * kk, (y - oy) * kk) : ctx.moveTo((x - ox) * kk, (y - oy) * kk)));
  ctx.stroke();
  // Zero-length strokes are pruned by canvas; stamp the end discs explicitly.
  for (const p of [points[0], points[points.length - 1]]) {
    ctx.beginPath();
    ctx.arc((p[0] - ox) * kk, (p[1] - oy) * kk, radius * kk, 0, Math.PI * 2);
    ctx.fill();
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  return maskToRegion(mask, w, h, ox, oy, kk, 0.6);
}
