import type { Annotation, Pt } from "@/types";
import { getLiveStats } from "./liveStats";

/**
 * Selection-inspector rows for radiology annotations, in physical units where known.
 * Pure: never imports Cornerstone (adapters load eagerly with the app shell).
 */
const KIND_NAME: Record<string, string> = {
  length: "Length",
  angle: "Angle",
  cobb: "Cobb angle",
  bidirectional: "Bidirectional",
  probe: "Probe",
  arrow: "Arrow",
  "ellipse-roi": "Ellipse ROI",
  "rectangle-roi": "Rectangle ROI",
  "freehand-roi": "Freehand ROI",
};

const f = (v: number, d = 1) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(d));

export function polygonArea(points: Pt[] | number[][]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function intensityRows(stats: Record<string, number>, valueUnit: string): [string, string][] {
  const rows: [string, string][] = [];
  if (stats.mean !== undefined) rows.push(["Mean", `${f(stats.mean)}${valueUnit}`]);
  if (stats.stdDev !== undefined) rows.push(["Std dev", `${f(stats.stdDev)}${valueUnit}`]);
  if (stats.min !== undefined && stats.max !== undefined) rows.push(["Min / max", `${f(stats.min)} / ${f(stats.max)}${valueUnit}`]);
  return rows;
}

export function inspectAnnotation(a: Annotation, ctx: { mode: "2d" | "3d"; modality?: string }): [string, string][] {
  const g = a.geometry;
  const live = getLiveStats(a.id);
  const mu = live?.modalityUnit && live.modalityUnit !== "raw" ? live.modalityUnit : undefined;
  const valueUnit = mu ? ` ${mu}` : ctx.modality === "CT" ? " HU" : "";
  switch (g.type) {
    case "box":
      return [
        ["Shape", "Box"],
        ["Position", `${f(g.x, 0)}, ${f(g.y, 0)} px`],
        ["Size", `${f(g.w, 0)} × ${f(g.h, 0)} px`],
        ["Area", `${f(g.w * g.h, 0)} px²`],
        ...intensityRows(live?.stats ?? {}, valueUnit),
      ];
    case "ellipse":
      return [
        ["Shape", "Ellipse"],
        ["Center", `${f(g.cx, 0)}, ${f(g.cy, 0)} px`],
        ["Radii", `${f(g.rx)} × ${f(g.ry)} px`],
        ["Area", `${f(Math.PI * g.rx * g.ry, 0)} px²`],
        ...intensityRows(live?.stats ?? {}, valueUnit),
      ];
    case "polygon":
      return [
        ["Shape", "Polygon"],
        ["Vertices", String(g.points.length)],
        ["Area", `${f(polygonArea(g.points), 0)} px²`],
        ...intensityRows(live?.stats ?? {}, valueUnit),
      ];
    case "keypoint":
      return [
        ["Shape", "Keypoint"],
        ["Position", `${f(g.x, 0)}, ${f(g.y, 0)} px`],
        ...(live?.stats.value !== undefined ? [["Value", `${f(live.stats.value)}${valueUnit}`] as [string, string]] : []),
      ];
    case "point":
      return [
        ["Shape", "Point"],
        ["Voxel (i, j, k)", g.ijk.join(", ")],
        ["Plane", `${g.plane} · slice ${g.slice + 1}`],
        ...(live?.stats.value !== undefined ? [["Value", f(live.stats.value)] as [string, string]] : []),
      ];
    case "measurement": {
      const stats = { ...(g.stats ?? {}), ...(live?.stats ?? {}) };
      const unit = g.unit ?? live?.unit ?? (g.space === "world" ? "mm" : "px");
      const areaUnit = live?.areaUnit ?? `${unit}²`;
      const rows: [string, string][] = [["Measurement", KIND_NAME[g.kind] ?? g.kind]];
      if (g.plane) rows.push(["Plane", `${g.plane}${g.slice !== undefined ? ` · slice ${g.slice + 1}` : ""}`]);
      if (g.kind === "length" && stats.length !== undefined) rows.push(["Length", `${f(stats.length, 2)} ${unit}`]);
      if ((g.kind === "angle" || g.kind === "cobb") && stats.angle !== undefined) rows.push(["Angle", `${f(stats.angle)}°`]);
      if (g.kind === "bidirectional") {
        if (stats.length !== undefined) rows.push(["Long axis", `${f(stats.length, 2)} ${unit}`]);
        if (stats.width !== undefined) rows.push(["Short axis", `${f(stats.width, 2)} ${unit}`]);
      }
      if (g.kind === "probe" && stats.value !== undefined) rows.push(["Value", `${f(stats.value)}${valueUnit}`]);
      if (g.kind.endsWith("-roi")) {
        if (stats.area !== undefined) rows.push(["Area", `${f(stats.area, 2)} ${areaUnit}`]);
        else if (g.space === "image" && g.points.length > 2 && g.kind === "freehand-roi") rows.push(["Area", `${f(polygonArea(g.points), 0)} px²`]);
        if (stats.perimeter !== undefined) rows.push(["Perimeter", `${f(stats.perimeter, 2)} ${unit}`]);
        rows.push(...intensityRows(stats, valueUnit));
      }
      if (g.text) rows.push(["Note", g.text]);
      if (g.space === "image" && unit === "px") rows.push(["Units", "pixels (image has no spacing)"]);
      return rows;
    }
    case "mask": {
      const voxels = g.voxels ?? 0;
      const rows: [string, string][] = [["Shape", "Mask"]];
      if (ctx.mode === "3d" || g.dims.length === 3) {
        rows.push(["Voxels", voxels.toLocaleString()]);
        if (g.volumeMm3 !== undefined) rows.push(["Volume", `${(g.volumeMm3 / 1000).toFixed(2)} mL (${f(g.volumeMm3, 0)} mm³)`]);
      } else {
        rows.push(["Area", g.volumeMm3 ? `${f(g.volumeMm3, 1)} mm² (${voxels.toLocaleString()} px)` : `${voxels.toLocaleString()} px²`]);
      }
      rows.push(["Grid", g.dims.join(" × ")]);
      if (a.attributes?.source) rows.push(["Source", String(a.attributes.source)]);
      rows.push(...intensityRows(live?.stats ?? {}, valueUnit));
      return rows;
    }
    default:
      return [];
  }
}
