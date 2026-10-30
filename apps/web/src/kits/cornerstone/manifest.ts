import * as z from "zod";
import { tool } from "@/kits/tool-catalog";
import { defineModule } from "@/platform/module";
import { ns } from "@studio/plugin-contracts/naming";

/**
 * Cornerstone3D tools and view commands, for renderers that declare the `cornerstone`
 * capability (2D stacks and MPR volumes). Shapes here are Cornerstone annotation tools and
 * so create `measurement` geometries with stats.
 */
const CS = "'cornerstone' in renderer.capabilities";
const sized = z.object({ size: z.number().int().min(2).max(120).default(16).describe("Diameter in screen pixels") });
const thresholdBrush = sized.extend({ threshold: z.boolean().default(false).describe("Only paint pixels whose intensity is inside the current window") });

export default defineModule({
  id: ns("cornerstone"),
  version: "1.0.0",
  title: "Cornerstone3D tools",
  description: "Radiology tools on Cornerstone3D viewports: zoom, crosshairs, ROI shapes, measurements, threshold brush, flood fill, view transforms.",
  contributes: {
    tools: [
      tool("zoom", { when: CS, description: "Drag to zoom" }),
      tool("crosshairs", { when: `${CS} && 'planes' in renderer.capabilities`, description: "Linked MPR crosshairs" }),
      tool("box", { creates: "measurement", when: CS, description: "Rectangle ROI with stats" }),
      tool("ellipse", { creates: "measurement", when: CS, description: "Ellipse ROI with stats" }),
      tool("polygon", { creates: "measurement", when: CS, description: "Spline / polygon ROI with stats" }),
      tool("freehand", { creates: "measurement", when: CS, description: "Freehand ROI with stats" }),
      tool("keypoint", { creates: "measurement", when: CS, description: "Landmark with the pixel value" }),
      tool("length", { creates: "measurement", when: CS, description: "Distance in mm" }),
      tool("angle", { creates: "measurement", when: CS, description: "Three-point angle" }),
      tool("cobb", { creates: "measurement", when: CS, description: "Cobb angle between two lines" }),
      tool("bidirectional", { creates: "measurement", when: CS, description: "RECIST long and short axes" }),
      tool("probe", { when: CS, description: "Pixel value (HU for CT); saved as a measurement but not a drawing tool" }),
      tool("arrow", { creates: "measurement", when: CS, description: "Arrow with a note" }),
      tool("brush", { creates: "mask", when: CS, optionsSchema: thresholdBrush, description: "Paint a labelmap, optionally thresholded to the window" }),
      tool("eraser", { creates: "mask", when: CS, optionsSchema: sized, description: "Erase a labelmap" }),
      tool("wand", { creates: "mask", when: CS, description: "Flood-fill a connected region of similar intensity" }),
    ],
    commands: [
      { id: "rotateViewLeft", keys: ["shift+l"], label: "Rotate 90° left", group: "View", when: CS, description: "Rotate the view 90° counter-clockwise" },
      { id: "toggleMagnifier", keys: ["m"], label: "Toggle magnifier", group: "View", when: CS, description: "Show or hide the hover magnifier" },
      { id: "invertImage", keys: ["shift+i"], label: "Invert", group: "View", when: CS, description: "Invert the grayscale" },
      { id: "flipHorizontal", keys: ["shift+h"], label: "Flip horizontally", group: "View", when: CS, description: "Mirror left–right" },
      { id: "flipVertical", keys: ["shift+v"], label: "Flip vertically", group: "View", when: CS, description: "Mirror top–bottom" },
    ],
  },
});
