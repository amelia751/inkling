import type { Annotation, Geometry, Pt } from "@studio/contracts/types";
import { pathLength } from "@studio/renderers/overlay2d/geometry";
import { geometryBounds, pointInRegion, regionArea, regionOf, regionPerimeter, type Region } from "@studio/renderers/overlay2d/regions";

const fmt = (n: number, digits = 1) => n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: n < 10 && n % 1 ? digits : 0 });

/** Area in image px² → "1,234 µm²" or "1.23 mm²" (switches above 10⁶ µm²); px² when mpp is unknown. */
export function formatArea(px2: number, mpp: number | null): string {
  if (!mpp) return `${fmt(px2, 0)} px²`;
  const um2 = px2 * mpp * mpp;
  return um2 >= 1e6 ? `${fmt(um2 / 1e6, 3)} mm²` : `${fmt(um2, um2 < 100 ? 1 : 0)} µm²`;
}

/** Length in image px → "µm" / "mm" (above 1000 µm), px when mpp is unknown. */
export function formatLength(px: number, mpp: number | null): string {
  if (!mpp) return `${fmt(px, 0)} px`;
  const um = px * mpp;
  return um >= 1000 ? `${fmt(um / 1000, 2)} mm` : `${fmt(um, um < 10 ? 2 : 1)} µm`;
}

export function measurementLength(g: Geometry): number | null {
  if (g.type === "polyline") return pathLength(g.points);
  if (g.type === "measurement" && g.space === "image") return pathLength(g.points as Pt[]);
  return null;
}

/** Physical stats stored on a length measurement. */
export function lengthStats(px: number, mpp: number | null): Record<string, number> {
  return mpp ? { length_um: Math.round(px * mpp * 100) / 100, length_px: Math.round(px * 10) / 10 } : { length_px: Math.round(px * 10) / 10 };
}

/** Per-class point (keypoint) counts inside a region (or the whole item when region is null). */
export function countPoints(annotations: Annotation[], itemId: string, region: Region | null): Map<string, number> {
  const counts = new Map<string, number>();
  let bb: [number, number, number, number] | null = null;
  if (region) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [outer] of region)
      for (const [x, y] of outer) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    bb = [minX, minY, maxX, maxY];
  }
  for (const a of annotations) {
    if (a.itemId !== itemId || a.geometry.type !== "keypoint") continue;
    const { x, y } = a.geometry;
    if (region && bb) {
      if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
      if (!pointInRegion([x, y], region)) continue;
    }
    counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
  }
  return counts;
}

/** Rows for the sidebar selection inspector (`studio.wsi.inspectors.main`); `mpp` comes from the runtime. */
export function inspectRows(a: Annotation, mpp: number | null, all: Annotation[]): [string, string][] {
  const g = a.geometry;
  const rows: [string, string][] = [["Class", a.label]];
  const region = regionOf(g);
  if (region) {
    const area = regionArea(region);
    rows.push(["Area", formatArea(area, mpp)]);
    rows.push(["Perimeter", formatLength(regionPerimeter(region), mpp)]);
    if (g.type === "multipolygon") rows.push(["Pieces", String(g.polygons.length)]);
    const holes = region.reduce((s, p) => s + p.length - 1, 0);
    if (holes) rows.push(["Holes", String(holes)]);
    const counts = countPoints(all, a.itemId, region);
    const total = [...counts.values()].reduce((s, n) => s + n, 0);
    if (total) {
      rows.push(["Points inside", String(total)]);
      if (mpp && area) rows.push(["Density", `${fmt(total / (area * mpp * mpp * 1e-6), 0)} /mm²`]);
      for (const [label, n] of counts) rows.push([`  ${label}`, String(n)]);
    }
  }
  const len = measurementLength(g);
  if (len !== null) rows.push(["Length", formatLength(len, mpp)]);
  if (g.type === "keypoint") rows.push(["Position", `${Math.round(g.x).toLocaleString()}, ${Math.round(g.y).toLocaleString()} px`]);
  else {
    const bb = geometryBounds(g);
    if (bb) rows.push(["Bounds", `${Math.round(bb[2] - bb[0]).toLocaleString()} × ${Math.round(bb[3] - bb[1]).toLocaleString()} px`]);
  }
  if (!mpp) rows.push(["Scale", "µm/px unknown"]);
  return rows;
}
