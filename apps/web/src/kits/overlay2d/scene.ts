import Flatbush from "flatbush";
import simplifyPath from "simplify-js";
import { resolveLabelColor, resolveToken } from "@/lib/labels";
import type { Annotation, Geometry, Pt } from "@/types";
import { catmullRomClosed, distToSegment } from "@/kits/overlay2d/geometry";
import { geometryBounds, pointInRegion, regionArea, regionOf, type BBox, type Region } from "@/kits/overlay2d/regions";
import type { View } from "@/kits/overlay2d/transform";

export type EntryKind = "mark" | "region" | "line";

export interface Entry {
  a: Annotation;
  kind: EntryKind;
  bbox: BBox;
  /** Image px²; 0 for marks and lines. */
  area: number;
  region?: Region;
  line?: Pt[];
}

/** Points / regions / open paths this viewer understands, normalised for drawing and hit tests. */
export function entryFor(a: Annotation): Entry | null {
  const g = a.geometry;
  const bbox = geometryBounds(g);
  if (!bbox || !bbox.every(Number.isFinite)) return null;
  if (g.type === "mark" || g.type === "keypoint") return { a, kind: "mark", bbox, area: 0 };
  if (g.type === "spline") {
    const region: Region = [[catmullRomClosed(g.points)]];
    return { a, kind: "region", bbox, area: regionArea(region), region };
  }
  const region = regionOf(g);
  if (region) return { a, kind: "region", bbox, area: regionArea(region), region };
  if (g.type === "polyline") return { a, kind: "line", bbox, area: 0, line: g.points };
  if (g.type === "measurement" && g.space === "image") return { a, kind: "line", bbox, area: 0, line: g.points as Pt[] };
  return null;
}

/**
 * Spatial index over one slide's visible annotations: a static R-tree (flatbush) plus a
 * small linear "delta" of recently added/changed entries and tombstones for removed ones.
 * Store edits (add one mark, move one polygon, delete a few) are diffed against the
 * previous list by reference in O(n) and patched in O(k); the R-tree is only rebuilt when
 * the delta or tombstones grow past DELTA_LIMIT or the diff is too large (undo of a batch).
 */
const DELTA_LIMIT = 1024;
const DIFF_BUDGET = 256;

export class Scene {
  /** Entry slots; indices are stable until the next full rebuild. Dead slots are tombstoned. */
  entries: Entry[] = [];
  private index: Flatbush | null = null;
  private indexed = 0;
  private dead = new Uint8Array(0);
  private deadCount = 0;
  private source: Annotation[] = [];
  /** Entry slot per source position (-1 when the annotation isn't drawn by this viewer). */
  private slots: number[] = [];
  private byId = new Map<string, number>();
  /** Last build: "full" rebuild or "patch" (diagnostics / perf self-check). */
  lastBuild: { mode: "full" | "patch" | "noop"; ms: number } = { mode: "noop", ms: 0 };

  build(list: Annotation[]) {
    if (list === this.source) return;
    const t0 = performance.now();
    const mode = this.source.length && this.patch(list) ? "patch" : (this.rebuild(list), "full");
    this.source = list;
    this.lastBuild = { mode, ms: performance.now() - t0 };
  }

  private rebuild(list: Annotation[]) {
    this.entries = [];
    this.slots = new Array(list.length);
    for (let k = 0; k < list.length; k++) {
      const e = entryFor(list[k]);
      this.slots[k] = e ? this.entries.push(e) - 1 : -1;
    }
    this.byId = new Map(this.entries.map((e, i) => [e.a.id, i]));
    this.dead = new Uint8Array(this.entries.length);
    this.deadCount = 0;
    this.indexed = this.entries.length;
    if (!this.entries.length) {
      this.index = null;
      return;
    }
    const index = new Flatbush(this.entries.length);
    for (const e of this.entries) index.add(e.bbox[0], e.bbox[1], e.bbox[2], e.bbox[3]);
    index.finish();
    this.index = index;
  }

  /** Order-preserving reference diff (replace / insert / delete / append). False → caller rebuilds. */
  private patch(list: Annotation[]): boolean {
    const old = this.source, oldSlots = this.slots;
    const slots: number[] = new Array(list.length);
    const kill: number[] = [];
    const add: [number, Annotation][] = [];
    let i = 0, j = 0, budget = DIFF_BUDGET;
    while (i < old.length && j < list.length) {
      if (old[i] === list[j]) {
        slots[j++] = oldSlots[i++];
        continue;
      }
      if (--budget < 0) return false;
      if (i + 1 < old.length && old[i + 1] === list[j]) kill.push(oldSlots[i++]);
      else if (j + 1 < list.length && old[i] === list[j + 1]) add.push([j++, list[j - 1]]);
      else {
        kill.push(oldSlots[i++]);
        add.push([j++, list[j - 1]]);
      }
    }
    if (old.length - i + list.length - j > budget) return false;
    while (i < old.length) kill.push(oldSlots[i++]);
    while (j < list.length) add.push([j++, list[j - 1]]);
    const delta = this.entries.length - this.indexed + add.length;
    if (delta > DELTA_LIMIT || this.deadCount + kill.length > DELTA_LIMIT) return false;

    if (this.dead.length < this.entries.length + add.length) {
      const grown = new Uint8Array(Math.max(16, (this.entries.length + add.length) * 2));
      grown.set(this.dead);
      this.dead = grown;
    }
    for (const k of kill) {
      if (k < 0 || this.dead[k]) continue;
      this.dead[k] = 1;
      this.deadCount++;
      const id = this.entries[k].a.id;
      if (this.byId.get(id) === k) this.byId.delete(id);
    }
    for (const [pos, a] of add) {
      const e = entryFor(a);
      if (!e) {
        slots[pos] = -1;
        continue;
      }
      const k = this.entries.push(e) - 1;
      slots[pos] = k;
      this.byId.set(a.id, k);
    }
    this.slots = slots;
    return true;
  }

  get(id: string | null): Entry | undefined {
    if (!id) return undefined;
    const k = this.byId.get(id);
    return k === undefined ? undefined : this.entries[k];
  }

  /** Live entries (skips tombstones). */
  *alive(): Generator<Entry> {
    for (let k = 0; k < this.entries.length; k++) if (!this.dead[k]) yield this.entries[k];
  }

  get size(): number {
    return this.entries.length - this.deadCount;
  }

  search(minX: number, minY: number, maxX: number, maxY: number): number[] {
    const dead = this.dead;
    const out = this.index ? (this.deadCount ? this.index.search(minX, minY, maxX, maxY, (i) => !dead[i]) : this.index.search(minX, minY, maxX, maxY)) : [];
    for (let k = this.indexed; k < this.entries.length; k++) {
      if (dead[k]) continue;
      const b = this.entries[k].bbox;
      if (b[0] <= maxX && b[2] >= minX && b[1] <= maxY && b[3] >= minY) out.push(k);
    }
    return out;
  }

  /**
   * Topmost object under p (image px) within `tol` image px. Points and lines win over
   * regions; among regions the smallest containing one wins, so nested objects stay reachable.
   */
  hitTest(p: Pt, tol: number, accept: (e: Entry) => boolean = () => true): Entry | null {
    const ids = this.search(p[0] - tol, p[1] - tol, p[0] + tol, p[1] + tol);
    let bestPoint: Entry | null = null, bestPointD = tol;
    let bestRegion: Entry | null = null;
    for (const i of ids) {
      const e = this.entries[i];
      if (!accept(e)) continue;
      if (e.kind === "mark") {
        const g = e.a.geometry as { x: number; y: number };
        const d = Math.hypot(g.x - p[0], g.y - p[1]);
        if (d <= bestPointD) {
          bestPointD = d;
          bestPoint = e;
        }
      } else if (e.kind === "line") {
        const pts = e.line!;
        for (let k = 0; k + 1 < pts.length; k++) {
          const { d } = distToSegment(p, pts[k], pts[k + 1]);
          if (d <= bestPointD) {
            bestPointD = d;
            bestPoint = e;
          }
        }
      } else if (!bestRegion || e.area < bestRegion.area) {
        if (pointInRegion(p, e.region!) || nearRegionEdge(p, e.region!, tol)) bestRegion = e;
      }
    }
    return bestPoint ?? bestRegion;
  }
}

function nearRegionEdge(p: Pt, region: Region, tol: number): boolean {
  for (const poly of region)
    for (const ring of poly)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (distToSegment(p, ring[j], ring[i]).d <= tol) return true;
  return false;
}

export function regionContains(e: Entry, p: Pt): boolean {
  return e.kind === "region" ? pointInRegion(p, e.region!) : false;
}

// ---- Level-of-detail path cache ----

/** LOD bucket: 0 at ≥1 screen px per image px, +1 per halving of zoom. */
export function lodFor(scale: number): number {
  return Math.max(0, Math.min(16, Math.floor(Math.log2(1 / scale))));
}

const pathCache = new WeakMap<Geometry, Map<number, Path2D>>();

function ringPath(path: Path2D, ring: Pt[], tol: number, closed: boolean) {
  let pts: { x: number; y: number }[] | Pt[] = ring;
  if (tol > 0 && ring.length > 8) {
    const s = simplifyPath(ring.map(([x, y]) => ({ x, y })), tol, false);
    if (s.length >= (closed ? 3 : 2)) pts = s;
  }
  const xy = (q: { x: number; y: number } | Pt): [number, number] => (Array.isArray(q) ? q : [q.x, q.y]);
  pts.forEach((q, i) => {
    const [x, y] = xy(q);
    if (i) path.lineTo(x, y);
    else path.moveTo(x, y);
  });
  if (closed) path.closePath();
}

/** Image-space Path2D for an entry, simplified to ~half a screen pixel at this LOD; cached per geometry object. */
export function pathFor(e: Entry, lod: number): Path2D {
  let byLod = pathCache.get(e.a.geometry);
  if (!byLod) pathCache.set(e.a.geometry, (byLod = new Map()));
  let path = byLod.get(lod);
  if (path) return path;
  const tol = lod === 0 ? 0 : 0.5 * 2 ** lod;
  path = new Path2D();
  if (e.kind === "region") for (const poly of e.region!) for (const ring of poly) ringPath(path, ring, tol, true);
  else if (e.kind === "line") ringPath(path, e.line!, tol, false);
  byLod.set(lod, path);
  return path;
}

// ---- Bulk layer ----

export interface SceneStyle {
  labels: string[];
  opacity: number;
  outlineOnly: boolean;
  showNames: boolean;
  /** Drawn by the edit layer instead (selected / being edited). */
  skip: ReadonlySet<string> | null;
  mpp: number | null;
  formatLength: (px: number) => string;
}

export interface DrawStats {
  candidates: number;
  regions: number;
  dots: number;
  marks: number;
  ms: number;
}

const MARK_DETAIL_LIMIT = 4000;
const MAX_TAGS = 300;

class Palette {
  private cache = new Map<string, string>();
  constructor(private labels: string[]) {}
  get(label: string, alpha: number): string {
    const k = `${label}|${alpha}`;
    let c = this.cache.get(k);
    if (!c) this.cache.set(k, (c = resolveLabelColor(this.labels, label, alpha)));
    return c;
  }
}

/**
 * Draw every visible annotation. Regions and lines are cached image-space Path2Ds drawn
 * under the view matrix (so pan/zoom/rotate costs no geometry work); objects under ~2 screen
 * px collapse to single dots; marks switch from outlined discs to deduplicated 2-px squares
 * when more than a few thousand are on screen.
 */
export function drawScene(ctx: CanvasRenderingContext2D, dpr: number, view: View, scene: Scene, style: SceneStyle): DrawStats {
  const t0 = performance.now();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const [minX, minY, maxX, maxY] = view.visibleImageBounds(24);
  const ids = scene.search(minX, minY, maxX, maxY);
  const stats: DrawStats = { candidates: ids.length, regions: 0, dots: 0, marks: 0, ms: 0 };
  if (!ids.length) return stats;
  const palette = new Palette(style.labels);
  const aiColor = resolveToken("--prov-ai");
  const scale = view.scale;
  const lod = lodFor(scale);
  const fillAlpha = 0.22 * style.opacity;

  const regions: Entry[] = [];
  const marks: Entry[] = [];
  const dots = new Map<string, Pt[]>();
  for (const i of ids) {
    const e = scene.entries[i];
    if (style.skip?.has(e.a.id)) continue;
    if (e.kind === "mark") {
      marks.push(e);
      continue;
    }
    const size = Math.max(e.bbox[2] - e.bbox[0], e.bbox[3] - e.bbox[1]) * scale;
    if (size < 2) {
      const list = dots.get(e.a.label) ?? [];
      list.push([(e.bbox[0] + e.bbox[2]) / 2, (e.bbox[1] + e.bbox[3]) / 2]);
      dots.set(e.a.label, list);
    } else regions.push(e);
  }
  // Large first so small (often nested) objects stay visible on top.
  regions.sort((a, b) => b.area - a.area);

  view.apply(ctx, dpr);
  const px = 1 / scale;
  for (const e of regions) {
    const path = pathFor(e, lod);
    const ai = e.a.provenance === "ai-suggested";
    if (e.kind === "region" && !style.outlineOnly && fillAlpha > 0) {
      ctx.fillStyle = palette.get(e.a.label, fillAlpha);
      ctx.fill(path, "evenodd");
    }
    ctx.strokeStyle = ai ? aiColor : palette.get(e.a.label, 1);
    ctx.lineWidth = (e.kind === "line" ? 2 : 1.5) * px;
    ctx.setLineDash(ai ? [6 * px, 4 * px] : []);
    ctx.stroke(path);
  }
  ctx.setLineDash([]);
  stats.regions = regions.length;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const [label, list] of dots) {
    ctx.fillStyle = palette.get(label, 1);
    ctx.beginPath();
    for (const [x, y] of list) {
      const [sx, sy] = view.toScreen(x, y);
      ctx.rect(sx - 1, sy - 1, 2, 2);
    }
    ctx.fill();
    stats.dots += list.length;
  }

  // Length / polyline labels in screen space.
  ctx.font = "11px Inter, sans-serif";
  for (const e of regions) {
    if (e.kind !== "line") continue;
    const pts = e.line!;
    let len = 0;
    for (let k = 0; k + 1 < pts.length; k++) len += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
    if (len * scale < 40) continue;
    const [sx, sy] = view.toScreen(...pts[pts.length - 1]);
    pill(ctx, sx + 8, sy - 8, style.formatLength(len));
  }

  if (marks.length) drawMarks(ctx, view, marks, palette, aiColor, stats, style.opacity);

  if (style.showNames) {
    let n = 0;
    for (let k = regions.length - 1; k >= 0 && n < MAX_TAGS; k--) {
      const e = regions[k];
      if (e.kind !== "region") continue;
      const corners = [view.toScreen(e.bbox[0], e.bbox[1]), view.toScreen(e.bbox[2], e.bbox[3]), view.toScreen(e.bbox[0], e.bbox[3]), view.toScreen(e.bbox[2], e.bbox[1])];
      const sx = Math.min(...corners.map((c) => c[0])), sy = Math.min(...corners.map((c) => c[1]));
      const w = Math.max(...corners.map((c) => c[0])) - sx;
      if (w < 36) continue;
      const name = typeof e.a.attributes?.name === "string" ? e.a.attributes.name : e.a.label;
      tag(ctx, Math.max(2, sx), Math.max(16, sy), name, palette.get(e.a.label, 0.9));
      n++;
    }
  }
  stats.ms = performance.now() - t0;
  return stats;
}

function drawMarks(ctx: CanvasRenderingContext2D, view: View, marks: Entry[], palette: Palette, aiColor: string, stats: DrawStats, opacity: number) {
  const W = Math.ceil(view.width), H = Math.ceil(view.height);
  const byLabel = new Map<string, Entry[]>();
  for (const e of marks) {
    const list = byLabel.get(e.a.label) ?? [];
    list.push(e);
    byLabel.set(e.a.label, list);
  }
  const detailed = marks.length <= MARK_DETAIL_LIMIT && view.scale > 0.02;
  if (!detailed) {
    // One 2-px square per occupied screen cell and class: 50k marks → a few thousand rects.
    const grid = new Uint8Array(Math.ceil(W / 2) * Math.ceil(H / 2) + 1);
    const gw = Math.ceil(W / 2);
    let cls = 0;
    for (const [label, list] of byLabel) {
      cls = (cls % 254) + 1;
      ctx.fillStyle = palette.get(label, Math.max(0.5, opacity));
      ctx.beginPath();
      for (const e of list) {
        const g = e.a.geometry as { x: number; y: number };
        const [sx, sy] = view.toScreen(g.x, g.y);
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const cell = (sy >> 1) * gw + (sx >> 1);
        if (grid[cell] === cls) continue;
        grid[cell] = cls;
        ctx.rect(sx - 1.5, sy - 1.5, 3, 3);
        stats.marks++;
      }
      ctx.fill();
    }
    return;
  }
  const r = view.scale > 0.5 ? 5 : 4;
  for (const [label, list] of byLabel) {
    ctx.beginPath();
    const ai: Pt[] = [];
    for (const e of list) {
      const g = e.a.geometry as { x: number; y: number };
      const [sx, sy] = view.toScreen(g.x, g.y);
      ctx.moveTo(sx + r, sy);
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      if (e.a.provenance === "ai-suggested") ai.push([sx, sy]);
    }
    ctx.fillStyle = palette.get(label, Math.max(0.6, opacity));
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.25;
    ctx.stroke();
    if (ai.length) {
      ctx.beginPath();
      for (const [sx, sy] of ai) {
        ctx.moveTo(sx + r + 2.5, sy);
        ctx.arc(sx, sy, r + 2.5, 0, Math.PI * 2);
      }
      ctx.strokeStyle = aiColor;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    stats.marks += list.length;
  }
}

export function pill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = "11px Inter, sans-serif";
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = "rgba(0,0,0,0.72)";
  ctx.beginPath();
  ctx.roundRect(x, y - 15, w, 18, 4);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + 5, y - 2);
  ctx.restore();
}

function tag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, background: string) {
  ctx.save();
  ctx.font = "11px Inter, sans-serif";
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = background;
  ctx.fillRect(x, y - 15, w, 15);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + 4, y - 4);
  ctx.restore();
}
