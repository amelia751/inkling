import { difference } from "polyclip-ts";
import type { Annotation, Geometry, Project, Pt, SeedAsset } from "@studio/contracts/types";
import {
  catmullRomClosed,
  interpolateRings,
  pathLength,
  pointInPolygon,
  polygonArea,
  rasterizePolygon,
  resample,
  rleDecode,
  simplify,
} from "@studio/renderers/overlay2d/geometry";

/**
 * Pure slice × frame model: contour geometry, label maps, per-structure areas and slice
 * coverage per frame, and key frames (phases). Shared by the renderer, the inspector, the
 * exporters and (through public.ts) modules such as inkling.cardiac-metrics.
 *
 * Structures are configured, never guessed from label text: `structures` maps the roles
 * rv / myo / lv to label ids (renderer config, set by preset:cine-4d). With none
 * configured the module still works for any slice × frame data.
 *
 * Enclosure rule: a `myo` contour that encloses an `lv` contour on the same slice and
 * frame is an outer (epicardial) border; its region is then outer − inner. A `myo`
 * contour that encloses no `lv` contour is the region itself.
 */

export type ContourGeometry = Extract<Geometry, { type: "spline" | "polygon" }>;
export type MaskGeometry = Extract<Geometry, { type: "mask" }>;
export type InstantGeometry = Extract<Geometry, { type: "instant" }>;
export type ContourAnn = Annotation & { geometry: ContourGeometry };
export type MaskAnn = Annotation & { geometry: MaskGeometry };
/** A key-frame marker: core `instant` with `attributes: { kind: "phase", phase }`. */
export type PhaseAnn = Annotation & { geometry: InstantGeometry & { frame: number }; attributes: { kind: "phase"; phase: string } };

export type StructKey = "rv" | "myo" | "lv";
export const STRUCT_KEYS: StructKey[] = ["rv", "myo", "lv"];
export const STRUCT_SHORT: Record<StructKey, string> = { rv: "RV", myo: "MYO", lv: "LV" };
/** Structure role → label id (from config; missing roles are undefined). */
export type Structures = Record<StructKey, string | undefined>;

export const isContour = (a: Annotation): a is ContourAnn =>
  (a.geometry.type === "spline" || a.geometry.type === "polygon") && a.geometry.frame !== undefined && a.geometry.slice !== undefined;
export const isMask = (a: Annotation): a is MaskAnn => a.geometry.type === "mask" && a.geometry.frame !== undefined && a.geometry.slice !== undefined;
export const isPhase = (a: Annotation): a is PhaseAnn =>
  a.geometry.type === "instant" && a.geometry.frame !== undefined && a.attributes?.kind === "phase" && typeof a.attributes.phase === "string";

/** Label value in label maps: its index + 1 in the environment's label list. */
export const labelValue = (labels: string[], label: string) => labels.indexOf(label) + 1;

/** Structure role of a label, if it has one. */
export const structureOf = (structs: Structures, label: string): StructKey | undefined => STRUCT_KEYS.find((k) => structs[k] === label);

export interface Grid {
  nx: number;
  ny: number;
  nz: number;
  frames: number;
  /** mm: in-plane x, in-plane y, slice spacing. */
  spacing: [number, number, number];
}

// ---------- contour geometry ----------

const ringCache = new WeakMap<Geometry, Pt[]>();

/** Dense closed ring of a contour in voxel coordinates (spline sampled, polygon as is). */
export function ring(g: ContourGeometry): Pt[] {
  let r = ringCache.get(g);
  if (!r) {
    r = g.type === "spline" && g.points.length >= 3 ? catmullRomClosed(g.points, 12) : g.points;
    ringCache.set(g, r);
  }
  return r;
}

export const ringArea = (g: ContourGeometry) => polygonArea(ring(g));

function ringInside(inner: Pt[], outer: Pt[]): boolean {
  return inner.every((p) => pointInPolygon(p, outer));
}

/** Area (voxel²) of a myocardium contour after removing the LV contours it encloses. */
export function myoArea(epi: ContourGeometry, lvs: ContourGeometry[]): { area: number; epicardial: boolean } {
  const outer = ring(epi);
  const enclosed = lvs.filter((lv) => pointInPolygon(centroidOf(ring(lv)), outer));
  if (!enclosed.length) return { area: polygonArea(outer), epicardial: false };
  if (enclosed.every((lv) => ringInside(ring(lv), outer))) {
    return { area: Math.max(0, polygonArea(outer) - enclosed.reduce((s, lv) => s + polygonArea(ring(lv)), 0)), epicardial: true };
  }
  // Endocardium crosses the epicardium: clip properly.
  try {
    const res = difference([outer], ...enclosed.map((lv) => [ring(lv)]));
    const area = res.reduce((s, poly) => s + polygonArea(poly[0], poly.slice(1)), 0);
    return { area, epicardial: true };
  } catch {
    return { area: polygonArea(outer), epicardial: true };
  }
}

function centroidOf(pts: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

export const perimeterMm = (g: ContourGeometry, sx: number, sy: number) => pathLength(ring(g), true, sx, sy);

// ---------- per slice/frame grouping ----------

export interface Cell {
  contours: ContourAnn[];
  masks: MaskAnn[];
}

export const cellKey = (slice: number, frame: number) => `${slice}:${frame}`;

export function groupCells(annotations: Annotation[], itemId: string): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const a of annotations) {
    if (a.itemId !== itemId) continue;
    if (!isContour(a) && !isMask(a)) continue;
    const g = a.geometry as ContourGeometry | MaskGeometry;
    const k = cellKey(g.slice!, g.frame!);
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { contours: [], masks: [] }));
    if (isContour(a)) c.contours.push(a);
    else c.masks.push(a as MaskAnn);
  }
  return cells;
}

/**
 * Paint order for label maps: labels without a structure role first (in label order), then
 * RV, MYO and LV, so an LV cavity painted last carves the myocardium ring out of its
 * epicardium. Value = label index + 1 (ACDC style for the seed labels: 1 RV, 2 MYO, 3 LV).
 */
export function paintOrder(labels: string[], structs: Structures): string[] {
  const roles = STRUCT_KEYS.map((k) => structs[k]).filter((l): l is string => !!l && labels.includes(l));
  return [...labels.filter((l) => !roles.includes(l)), ...roles];
}

/** Label map (uint8, nx·ny) of one cell, painted in `paintOrder`. */
export function cellLabelMap(cell: Cell, labels: string[], structs: Structures, nx: number, ny: number, out = new Uint8Array(nx * ny)): Uint8Array {
  for (const name of paintOrder(labels, structs)) {
    const v = labelValue(labels, name);
    for (const c of cell.contours) if (c.label === name && c.geometry.points.length >= 3) rasterizePolygon([ring(c.geometry)], nx, ny, out, v);
    for (const m of cell.masks) if (m.label === name) rleDecode(m.geometry.counts, nx * ny, out, v);
  }
  return out;
}

/** Areas in mm² per structure for one cell. Analytic for contours; pixel counts once masks are involved. */
export function cellAreas(cell: Cell, labels: string[], structs: Structures, grid: Grid): Record<StructKey, number> {
  const s = structs;
  const px = grid.spacing[0] * grid.spacing[1];
  const out: Record<StructKey, number> = { rv: 0, myo: 0, lv: 0 };
  if (cell.masks.length) {
    const map = cellLabelMap(cell, labels, structs, grid.nx, grid.ny);
    const vals = STRUCT_KEYS.map((k) => (s[k] ? labelValue(labels, s[k]!) : -1));
    for (let i = 0; i < map.length; i++) {
      const v = map[i];
      if (!v) continue;
      const k = vals.indexOf(v);
      if (k >= 0) out[STRUCT_KEYS[k]] += px;
    }
    return out;
  }
  const lvs = cell.contours.filter((c) => c.label === s.lv).map((c) => c.geometry);
  for (const c of cell.contours) {
    if (c.geometry.points.length < 3) continue;
    if (c.label === s.lv) out.lv += ringArea(c.geometry) * px;
    else if (c.label === s.rv) out.rv += ringArea(c.geometry) * px;
    else if (c.label === s.myo) out.myo += myoArea(c.geometry, lvs).area * px;
  }
  return out;
}

// ---------- key frames (phases) ----------

export interface PhaseMark {
  frame: number;
  source: "marked" | "reference" | "meta";
  id?: string;
}

/**
 * Frame of each key frame id (e.g. ED, ES): a marked `instant` (attributes.phase) wins, then
 * a reference asset tagged with that phase, then `meta[<id lowercased>]`.
 */
export function resolvePhases(annotations: Annotation[], itemId: string, assets: SeedAsset[], meta: Project["meta"] | undefined, ids: string[]): Record<string, PhaseMark | null> {
  const pick = (phase: string): PhaseMark | null => {
    const marked = annotations.find((a): a is PhaseAnn => a.itemId === itemId && isPhase(a) && a.attributes.phase === phase);
    if (marked) return { frame: marked.geometry.frame, source: "marked", id: marked.id };
    const ref = assets.find((a) => a.role === "reference" && a.phase === phase && a.frame !== undefined);
    if (ref) return { frame: ref.frame!, source: "reference" };
    const m = meta?.[phase.toLowerCase()];
    return typeof m === "number" ? { frame: m, source: "meta" } : null;
  };
  return Object.fromEntries(ids.map((id) => [id, pick(id)]));
}

/** Core geometry of a key-frame marker. */
export const phaseAnnotation = (phase: string, frame: number) => ({ geometry: { type: "instant" as const, frame }, attributes: { kind: "phase", phase } });

/**
 * Store ops that set key frames (one undo step): existing markers move, missing ones are
 * created with `newAnn` (the caller supplies label and provenance).
 */
export function phaseOps(annotations: Annotation[], itemId: string, frames: Record<string, number>, newAnn: (init: ReturnType<typeof phaseAnnotation>) => Annotation) {
  const ops = { update: [] as { id: string; patch: Partial<Annotation> }[], upsert: [] as Annotation[] };
  for (const [phase, frame] of Object.entries(frames)) {
    const init = phaseAnnotation(phase, frame);
    const existing = annotations.find((a) => a.itemId === itemId && isPhase(a) && a.attributes.phase === phase);
    if (existing) ops.update.push({ id: existing.id, patch: { geometry: init.geometry } });
    else ops.upsert.push(newAnn(init));
  }
  return ops;
}

// ---------- slice coverage per frame ----------

export type Completeness = "empty" | "partial" | "complete";

export interface FrameMetrics {
  frame: number;
  /** slice → mm² per structure (only slices with any annotation). */
  areas: Map<number, Record<StructKey, number>>;
  /** mL per structure (Σ area × slice spacing), null if nothing contoured. */
  volume: Record<StructKey, number | null>;
  status: Record<StructKey, Completeness>;
  /** Slices that look missing for each structure (gaps, or present in the reference). */
  missing: Record<StructKey, number[]>;
}

/** Slices that contain each structure in a reference label volume (for completeness). */
export function referenceSlices(ref: { data: ArrayLike<number> }, labels: string[], structs: Structures, grid: Grid): Record<StructKey, Set<number>> {
  const s = structs;
  const out: Record<StructKey, Set<number>> = { rv: new Set(), myo: new Set(), lv: new Set() };
  const n = grid.nx * grid.ny;
  for (let z = 0; z < grid.nz; z++) {
    for (let i = z * n; i < (z + 1) * n; i++) {
      const v = ref.data[i];
      if (!v) continue;
      for (const k of STRUCT_KEYS) if (s[k] && labelValue(labels, s[k]!) === v) out[k].add(z);
    }
  }
  return out;
}

/**
 * Per frame: areas per slice, volumes and how completely each structure covers the
 * slices (gaps, slices present in the reference, or far fewer slices than other frames).
 */
export function frameCoverage(opts: {
  annotations: Annotation[];
  itemId: string;
  labels: string[];
  structures: Structures;
  grid: Grid;
  /** Reference structure slices per frame, when a reference segmentation exists there. */
  refSlices?: Map<number, Record<StructKey, Set<number>>>;
}): FrameMetrics[] {
  const { grid, labels, structures: structs } = opts;
  const cells = groupCells(opts.annotations, opts.itemId);
  const frames: FrameMetrics[] = [];
  // Most slices each structure covers in any frame: a frame covering far fewer is incomplete.
  const edCount: Record<StructKey, number> = { rv: 0, myo: 0, lv: 0 };
  {
    const perFrame = new Map<number, Record<StructKey, number>>();
    for (const [key, c] of cells) {
      const f = +key.split(":")[1];
      const a = cellAreas(c, labels, structs, grid);
      const n = perFrame.get(f) ?? { rv: 0, myo: 0, lv: 0 };
      for (const k of STRUCT_KEYS) if (a[k] > 0) n[k]++;
      perFrame.set(f, n);
    }
    for (const n of perFrame.values()) for (const k of STRUCT_KEYS) edCount[k] = Math.max(edCount[k], n[k]);
  }
  for (let f = 0; f < grid.frames; f++) {
    const areas = new Map<number, Record<StructKey, number>>();
    for (let z = 0; z < grid.nz; z++) {
      const c = cells.get(cellKey(z, f));
      if (c) areas.set(z, cellAreas(c, labels, structs, grid));
    }
    const volume = { rv: null, myo: null, lv: null } as Record<StructKey, number | null>;
    const status = { rv: "empty", myo: "empty", lv: "empty" } as Record<StructKey, Completeness>;
    const missing = { rv: [], myo: [], lv: [] } as Record<StructKey, number[]>;
    for (const k of STRUCT_KEYS) {
      const present = [...areas.entries()].filter(([, a]) => a[k] > 0).map(([z]) => z);
      if (!present.length) continue;
      volume[k] = (present.reduce((s, z) => s + areas.get(z)![k], 0) * grid.spacing[2]) / 1000;
      const lo = Math.min(...present), hi = Math.max(...present);
      const miss = new Set<number>();
      for (let z = lo; z <= hi; z++) if (!present.includes(z)) miss.add(z);
      opts.refSlices?.get(f)?.[k].forEach((z) => !present.includes(z) && miss.add(z));
      missing[k] = [...miss].sort((a, b) => a - b);
      // Allow one slice of through-plane motion (base descends in systole).
      const short = edCount[k] >= 3 && present.length < edCount[k] - 1;
      status[k] = miss.size || short ? "partial" : "complete";
    }
    frames.push({ frame: f, areas, volume, status, missing });
  }
  return frames;
}

// ---------- contour construction ----------

/** Freehand path → 12–20 control points for a spline. */
export function toControlPoints(path: Pt[]): Pt[] {
  if (path.length < 3) return path;
  let tol = 0.25;
  let pts = simplify(path, tol);
  while (pts.length > 20 && tol < 64) pts = simplify(path, (tol *= 1.5));
  // simplify keeps the closing point when the path ends where it started.
  if (pts.length > 3 && Math.hypot(pts[0][0] - pts.at(-1)![0], pts[0][1] - pts.at(-1)![1]) < 1) pts = pts.slice(0, -1);
  if (pts.length < 12) pts = resample(path, 12);
  return pts.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)] as Pt);
}

/** Shape-interpolated control points between two contours (t ∈ (0,1)). */
export function interpolateContour(a: ContourGeometry, b: ContourGeometry, t: number): Pt[] {
  const k = Math.max(8, Math.min(24, Math.round((a.points.length + b.points.length) / 2)));
  const mid = interpolateRings(ring(a), ring(b), t, 96);
  return resample(mid, k).map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)] as Pt);
}

/**
 * Outer boundary of the largest 4-connected component of a binary mask (holes filled),
 * as a ring of pixel corners in voxel coordinates. Null if the mask is empty.
 */
export function traceLargest(mask: Uint8Array, nx: number, ny: number): Pt[] | null {
  // Label components.
  const comp = new Int32Array(nx * ny).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || comp[s] !== -1) continue;
    let size = 0;
    comp[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % nx, y = (p / nx) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < nx - 1 ? p + 1 : -1, y > 0 ? p - nx : -1, y < ny - 1 ? p + nx : -1];
      for (const q of nb) if (q >= 0 && mask[q] && comp[q] === -1) {
        comp[q] = id;
        stack.push(q);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
    id++;
  }
  if (best < 0) return null;
  // Fill holes: background not reachable from the border is inside.
  const W = nx + 2, H = ny + 2;
  const fg = (x: number, y: number) => x >= 0 && y >= 0 && x < nx && y < ny && comp[y * nx + x] === best;
  const outside = new Uint8Array(W * H);
  const q: number[] = [0];
  outside[0] = 1;
  while (q.length) {
    const p = q.pop()!;
    const x = (p % W) - 1, y = ((p / W) | 0) - 1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy;
      if (X < -1 || Y < -1 || X > nx || Y > ny) continue;
      const P = (Y + 1) * W + (X + 1);
      if (outside[P] || fg(X, Y)) continue;
      outside[P] = 1;
      q.push(P);
    }
  }
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < nx && y < ny && !outside[(y + 1) * W + (x + 1)];
  // Directed boundary edges with the region on the right (screen y down → clockwise rings).
  const next = new Map<number, number[]>();
  const vid = (x: number, y: number) => y * (nx + 1) + x;
  const addEdge = (ax: number, ay: number, bx: number, by: number) => {
    const k = vid(ax, ay);
    const l = next.get(k);
    if (l) l.push(vid(bx, by));
    else next.set(k, [vid(bx, by)]);
  };
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!inside(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!inside(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!inside(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  let longest: Pt[] = [];
  while (next.size) {
    const [start] = next.keys();
    const loop: Pt[] = [];
    let v = start;
    for (let guard = 0; guard < 4 * nx * ny; guard++) {
      const outs = next.get(v);
      if (!outs?.length) break;
      const w = outs.pop()!;
      if (!outs.length) next.delete(v);
      loop.push([v % (nx + 1), Math.floor(v / (nx + 1))]);
      v = w;
      if (v === start) break;
    }
    if (loop.length > longest.length) longest = loop;
  }
  return longest.length >= 4 ? longest : null;
}

/** Boundary of a mask → smooth spline control points (≈ 10–24). */
export function maskToControlPoints(mask: Uint8Array, nx: number, ny: number): Pt[] | null {
  const corners = traceLargest(mask, nx, ny);
  if (!corners) return null;
  // Edge midpoints lie on the staircase's centre line; corners would bias the spline outwards.
  const boundary = corners.map((p, i) => {
    const q = corners[(i + 1) % corners.length];
    return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as Pt;
  });
  let pts = simplify(boundary, 0.9);
  if (pts.length > 3 && pts[0][0] === pts.at(-1)![0] && pts[0][1] === pts.at(-1)![1]) pts = pts.slice(0, -1);
  if (pts.length > 24) pts = resample(boundary, 24);
  if (pts.length < 8) pts = resample(boundary, 8);
  return pts.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)] as Pt);
}
