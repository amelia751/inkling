import { ImageIcon } from "@studio/ui/icons";
import { defineModule } from "@studio/plugin-ui-sdk/module";
import type { Project, StudioItem } from "@studio/contracts/types";
import { StackConfigSchema } from "./view";
import { ns } from "@studio/contracts/naming";

export const IMAGE2D = ns("image2d");
const RASTER = `${IMAGE2D}.dataKinds.raster`;
const STACK = `${IMAGE2D}.renderers.cornerstone-stack`;
const CANVAS = `${IMAGE2D}.renderers.canvas-raster`;

/**
 * One item per image file. `group` is "Images", never the source label (todo8 D3, D8): the
 * Items panel follows the item's Data folder, and the label stays in `sourceLabel`.
 */
function groupItems(project: Project): StudioItem[] {
  return project.assets.map((a) => ({
    id: a.path,
    name: a.name ?? a.path.split("/").pop() ?? a.path,
    group: "Images",
    assets: [a],
    sourceLabel: a.label,
    dataKind: RASTER,
  }));
}

export default defineModule({
  id: IMAGE2D,
  version: "1.1.0",
  title: "2D images",
  description:
    "Single-frame images (PNG, JPEG, single-frame DICOM): a Cornerstone3D stack viewport with window/level, measurements and masks for radiology, or a light canvas renderer with boxes, polygons and keypoints for natural images.",
  requires: [ns("cornerstone")],
  contributes: {
    dataKinds: [
      { id: "raster", label: "2D image", icon: ImageIcon, itemNoun: "image", match: { ext: [".png", ".jpg", ".jpeg", ".webp", ".dcm"] }, groupItems, description: "Single-frame images, one item per file" },
    ],
    renderers: [
      {
        id: "cornerstone-stack",
        consumes: [RASTER],
        space: "image2d",
        capabilities: ["cornerstone", "windowLevel", "zoom", "rotate", "holdToPan", "overlayOpacity"],
        configSchema: StackConfigSchema,
        description: "Cornerstone3D stack viewport: window/level, invert, flip, rotate, magnifier, measurements, labelmaps; each view control can be switched off in config",
        example: { viewports: [{ name: "main", renderer: STACK, config: { windowLevel: false, colormap: false } }], panels: { "viewport-bar": [`${IMAGE2D}.panels.viewControls`] } },
      },
      {
        id: "canvas-raster",
        consumes: [RASTER],
        space: "image2d",
        capabilities: ["zoom", "pan", "holdToPan", "drafting", "vertexUndo"],
        description: "Plain <canvas> for natural images (PNG/JPEG/WebP, no DICOM): pan, wheel zoom, select / move / resize, and the overlay2d box, polygon and keypoint tools",
        example: {
          viewports: [{ name: "main", renderer: CANVAS }],
          tools: [ns("core.tools.select"), ns("core.tools.pan"), ns("overlay2d.tools.box"), ns("overlay2d.tools.polygon"), ns("overlay2d.tools.keypoint")],
        },
      },
    ],
    commands: [
      { id: "fitView", keys: ["0", "="], label: "Fit image to view", group: "View", description: "Reset zoom and pan (and, on the Cornerstone stack, flips, rotation and the window)" },
      {
        id: "cancelManipulation",
        keys: ["Escape"],
        label: "Cancel the drag or drawing in progress",
        group: "Drawing",
        contextual: true,
        when: `renderer == ${STACK}`,
        description: "Abort a Cornerstone tool drag or an unfinished measurement; otherwise Escape clears the selection",
      },
    ],
    panels: [
      {
        id: "viewControls",
        title: "View",
        slot: "viewport-bar",
        description: "Window/level presets, invert, flip, rotate, fit, color map, interpolation and magnifier for the Cornerstone stack (controls follow the renderer config), plus wand mode and remove-islands for mask tools",
      },
    ],
    inspectors: [{ id: "main", geometries: "*", description: "Physical measurements (mm, mm², HU) for Cornerstone annotations" }],
    exporters: [
      { id: "coco", label: "COCO JSON", accepts: ["box", "polygon", "keypoint", "measurement", "mask", "class"], description: "Boxes, polygons, RLE masks and keypoints in COCO format (pixel coordinates), plus image-level class labels." },
    ],
  },
  load: () => import("./impl"),
});
