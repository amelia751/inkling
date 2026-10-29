import * as z from "zod";
import { tool } from "@/kits/tool-catalog";
import { defineModule } from "@/platform/module";

/**
 * Vector editing on a 2D image plane (todo phase 4). Any renderer declaring
 * `space: "image2d"` gets these tools; the renderer implements them by name (`box`,
 * `polygon`…), preferably by hosting kits/overlay2d's OverlayEngine (`useOverlay2D`, or
 * directly as modules/wsi does), whose tool machines (tools/*.ts) use these names.
 */
const PLANE = "renderer.space == image2d";
const size = z.object({ size: z.number().int().min(2).max(120).default(16).describe("Diameter in screen pixels") });

export default defineModule({
  id: "inkling.overlay2d",
  version: "1.0.0",
  title: "2D overlay tools",
  description: "Box, ellipse, polygon, freehand, polyline, spline, keypoint, brush and eraser on any image-plane renderer.",
  contributes: {
    tools: [
      tool("box", { creates: "box", when: PLANE, description: "Axis-aligned box" }),
      tool("ellipse", { creates: "ellipse", when: PLANE, description: "Ellipse" }),
      tool("polygon", { creates: "polygon", when: PLANE, description: "Click-to-place polygon" }),
      tool("freehand", { creates: "polygon", when: PLANE, description: "Freehand closed outline" }),
      tool("polyline", { creates: "polyline", when: PLANE, description: "Open polyline" }),
      tool("spline", { creates: "spline", when: PLANE, description: "Smooth closed spline contour" }),
      tool("keypoint", { creates: "keypoint", when: PLANE, description: "Single landmark" }),
      tool("brush", { creates: "mask", when: PLANE, optionsSchema: size, description: "Paint a raster mask" }),
      tool("eraser", { creates: "mask", when: PLANE, optionsSchema: size, description: "Erase a raster mask" }),
    ],
  },
});
