import { CONSTANTS, type Types } from "@cornerstonejs/core";
import * as tools from "@cornerstonejs/tools";
import type { Annotation, Geometry, Plane } from "@studio/plugin-contracts/types";
import { KIND_TOOL, readStats, round, simplifyPolyline, TOOL_KIND, type Converter, type CsSpec } from "@studio/studio-renderers/cornerstone/bridge";
import { T } from "@studio/studio-renderers/cornerstone/init";
import { PLANES } from "../config";

type CsAnnotation = tools.Types.Annotation;

export interface VolumeGeometry {
  dims: [number, number, number];
  spacing: [number, number, number];
  /** Row-major 3×3: columns are the i, j, k axis directions in LPS. */
  direction: number[];
  indexToWorld(ijk: number[]): Types.Point3;
  worldToIndex(p: Types.Point3): Types.Point3;
  frameOfReferenceUID: string;
}

export function planeCamera(plane: Plane) {
  const v = CONSTANTS.MPR_CAMERA_VALUES[plane];
  return { viewPlaneNormal: [...v.viewPlaneNormal] as Types.Point3, viewUp: [...v.viewUp] as Types.Point3 };
}

export function planeFromNormal(n: ArrayLike<number> | undefined): Plane | undefined {
  if (!n) return undefined;
  let best: Plane | undefined;
  let score = 0.8;
  for (const plane of PLANES) {
    const m = CONSTANTS.MPR_CAMERA_VALUES[plane].viewPlaneNormal;
    const d = Math.abs(m[0] * n[0] + m[1] * n[1] + m[2] * n[2]);
    if (d > score) {
      score = d;
      best = plane;
    }
  }
  return best;
}

/** Voxel axis (0 = i, 1 = j, 2 = k) a plane slices through. */
export function planeAxis(geom: VolumeGeometry, plane: Plane): 0 | 1 | 2 {
  const n = CONSTANTS.MPR_CAMERA_VALUES[plane].viewPlaneNormal;
  let best: 0 | 1 | 2 = 2;
  let score = -1;
  for (const a of [0, 1, 2] as const) {
    const d = geom.direction;
    const axis = [d[a * 3], d[a * 3 + 1], d[a * 3 + 2]];
    const s = Math.abs(axis[0] * n[0] + axis[1] * n[1] + axis[2] * n[2]);
    if (s > score) {
      score = s;
      best = a;
    }
  }
  return best;
}

/** Drop redundant contour points (0.25 mm) using the plane's in-plane axes. */
function simplifyContour(points: Types.Point3[], plane: Plane): Types.Point3[] {
  const drop = plane === "axial" ? 2 : plane === "coronal" ? 1 : 0;
  const [a, b] = [0, 1, 2].filter((i) => i !== drop);
  return simplifyPolyline(points, 0.25, (p) => [p[a], p[b]]);
}

/**
 * Store ⇄ Cornerstone for one volume (subject). Measurements are stored in world (LPS mm)
 * coordinates with the plane / slice they were drawn on; landmarks as core `point3d`
 * {plane, slice, ijk} (stored v1 `point`s migrate on load).
 */
export function volumeConverter(geom: () => VolumeGeometry | null): Converter {
  const metadataFor = (plane: Plane) => {
    const g = geom()!;
    return { FrameOfReferenceUID: g.frameOfReferenceUID, ...planeCamera(plane) };
  };
  return {
    toCs(a: Annotation): CsSpec | null {
      const g = geom();
      if (!g) return null;
      const geo = a.geometry;
      if (geo.type === "point3d") {
        return { toolName: T.Keypoint, points: [g.indexToWorld(geo.ijk)], metadata: metadataFor(geo.plane) };
      }
      if (geo.type === "measurement" && geo.space === "world") {
        const toolName = geo.kind === "freehand-roi" && a.attributes?.tool === "polygon" ? T.Polygon : KIND_TOOL[geo.kind];
        return {
          toolName,
          points: geo.points.map((p) => [p[0], p[1], p[2]] as Types.Point3),
          metadata: metadataFor(geo.plane ?? "axial"),
          data: geo.kind === "arrow" ? { label: geo.text ?? "" } : undefined,
        };
      }
      return null;
    },

    fromCs(ann: CsAnnotation) {
      const g = geom();
      if (!g) return null;
      const name = ann.metadata?.toolName ?? "";
      const plane = planeFromNormal(ann.metadata?.viewPlaneNormal) ?? "axial";
      const handles = (ann.data.handles?.points ?? []) as Types.Point3[];
      const polyline = (ann.data.contour?.polyline ?? []) as Types.Point3[];
      const pts = name === tools.PlanarFreehandROITool.toolName ? simplifyContour(polyline, plane) : handles;
      if (!pts.length) return null;
      const ijk0 = g.worldToIndex(pts[0]);
      const axis = planeAxis(g, plane);
      const slice = Math.round(ijk0[axis]);
      if (name === T.Keypoint) {
        const ijk = ijk0.map((v, i) => Math.max(0, Math.min(g.dims[i] - 1, Math.round(v)))) as [number, number, number];
        return { geometry: { type: "point3d", plane, slice: ijk[axis], ijk } };
      }
      const kind = TOOL_KIND[name];
      if (!kind) return null;
      const { stats, unit } = readStats(ann);
      const text = name === tools.ArrowAnnotateTool.toolName ? (ann.data.label as string | undefined) : undefined;
      const geometry: Geometry = {
        type: "measurement",
        kind,
        points: pts.map((p) => [round(p[0], 3), round(p[1], 3), round(p[2], 3)]),
        space: "world",
        stats,
        unit: unit ?? "mm",
        plane,
        slice,
        ...(text ? { text } : {}),
      };
      return { geometry, attributes: name === T.Polygon ? { tool: "polygon" } : undefined };
    },
  };
}
