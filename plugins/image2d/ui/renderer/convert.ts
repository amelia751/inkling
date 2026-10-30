import { utilities as csUtils, type Types } from "@cornerstonejs/core";
import * as tools from "@cornerstonejs/tools";
import type { Annotation, Geometry, Pt } from "@studio/plugin-contracts/types";
import { KIND_TOOL, readStats, round, simplifyPolyline, TOOL_KIND, type Converter, type CsSpec } from "@studio/studio-renderers/cornerstone/bridge";
import { T } from "@studio/studio-renderers/cornerstone/init";

type CsAnnotation = tools.Types.Annotation;

/**
 * Store ⇄ Cornerstone conversion for a single 2D image. Store coordinates are image
 * pixels (0,0 = top-left corner of the first pixel), the convention of the existing
 * `box` annotations; Cornerstone works in world space.
 */
export function imageConverter(imageId: string, viewport: () => Types.IViewport | undefined, unit: string): Converter {
  const toWorld = (x: number, y: number) => csUtils.imageToWorldCoords(imageId, [x, y]) as Types.Point3;
  const toImage = (p: Types.Point3): Pt => {
    const [x, y] = csUtils.worldToImageCoords(imageId, p) as [number, number];
    return [round(x, 2), round(y, 2)];
  };
  const metadata = () => {
    const vp = viewport();
    const ref = (vp?.getViewReference() ?? {}) as Record<string, unknown>;
    delete ref.volumeId;
    return { ...ref, referencedImageId: imageId, FrameOfReferenceUID: ref.FrameOfReferenceUID ?? `inkimg.${imageId}` };
  };

  return {
    toCs(a: Annotation): CsSpec | null {
      const g = a.geometry;
      const md = metadata();
      switch (g.type) {
        case "box":
          return {
            toolName: tools.RectangleROITool.toolName,
            points: [toWorld(g.x, g.y), toWorld(g.x + g.w, g.y), toWorld(g.x, g.y + g.h), toWorld(g.x + g.w, g.y + g.h)],
            metadata: md,
          };
        case "ellipse":
          return {
            toolName: tools.EllipticalROITool.toolName,
            points: [toWorld(g.cx, g.cy + g.ry), toWorld(g.cx, g.cy - g.ry), toWorld(g.cx - g.rx, g.cy), toWorld(g.cx + g.rx, g.cy)],
            metadata: md,
          };
        case "polygon":
          if (g.points.length < 3) return null;
          return { toolName: T.Polygon, points: g.points.map(([x, y]) => toWorld(x, y)), metadata: md };
        case "keypoint":
          return { toolName: T.Keypoint, points: [toWorld(g.x, g.y)], metadata: md };
        case "measurement": {
          if (g.space !== "image") return null;
          const toolName = KIND_TOOL[g.kind];
          return {
            toolName,
            points: g.points.map(([x, y]) => toWorld(x, y)),
            metadata: md,
            data: g.kind === "arrow" ? { label: g.text ?? "" } : undefined,
          };
        }
        default:
          return null;
      }
    },

    fromCs(ann: CsAnnotation) {
      const name = ann.metadata?.toolName ?? "";
      const handles = (ann.data.handles?.points ?? []) as Types.Point3[];
      const pts = handles.map(toImage);
      const { stats, unit: csUnit } = readStats(ann);
      switch (name) {
        case tools.RectangleROITool.toolName: {
          if (pts.length < 4) return null;
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          const x = Math.min(...xs), y = Math.min(...ys);
          return { geometry: { type: "box", x, y, w: round(Math.max(...xs) - x), h: round(Math.max(...ys) - y) } };
        }
        case tools.EllipticalROITool.toolName: {
          if (pts.length < 4) return null;
          const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
          const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
          const rx = Math.max(...pts.map((p) => Math.abs(p[0] - cx)));
          const ry = Math.max(...pts.map((p) => Math.abs(p[1] - cy)));
          return { geometry: { type: "ellipse", cx: round(cx), cy: round(cy), rx: round(rx), ry: round(ry) } };
        }
        case T.Polygon:
          return pts.length >= 3 ? { geometry: { type: "polygon", points: pts } } : null;
        case T.Keypoint:
          return pts.length ? { geometry: { type: "keypoint", x: pts[0][0], y: pts[0][1] } } : null;
        default: {
          const kind = TOOL_KIND[name];
          if (!kind) return null;
          const polyline = (ann.data.contour?.polyline ?? []) as Types.Point3[];
          const points = name === tools.PlanarFreehandROITool.toolName ? simplifyPolyline(polyline.map(toImage), 0.5, (p) => p) : pts;
          if (!points.length) return null;
          const text = name === tools.ArrowAnnotateTool.toolName ? (ann.data.label as string | undefined) : undefined;
          const geometry: Geometry = {
            type: "measurement",
            kind,
            points,
            space: "image",
            stats,
            unit: csUnit ?? unit,
            ...(text ? { text } : {}),
          };
          return { geometry };
        }
      }
    },
  };
}
