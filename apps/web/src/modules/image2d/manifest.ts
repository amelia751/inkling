import { ImageIcon } from "@/components/icons";
import { defineModule } from "@/platform/module";
import type { Project, StudioItem } from "@/types";

export const IMAGE2D = "inkling.image2d";

/** One item per image file, grouped by the source label folder when there is one. */
function groupItems(project: Project): StudioItem[] {
  return project.assets.map((a) => ({
    id: a.path,
    name: a.path.split("/").pop() ?? a.path,
    group: a.label ? a.label[0].toUpperCase() + a.label.slice(1) : "Images",
    assets: [a],
    sourceLabel: a.label,
    dataKind: `${IMAGE2D}.dataKinds.raster`,
  }));
}

export default defineModule({
  id: IMAGE2D,
  version: "1.0.0",
  title: "2D images",
  description: "Single-frame images (PNG, JPEG, single-frame DICOM) on a Cornerstone3D stack viewport with window/level, measurements and masks.",
  requires: ["inkling.cornerstone"],
  contributes: {
    dataKinds: [
      { id: "raster", label: "2D image", icon: ImageIcon, itemNoun: "image", match: { ext: [".png", ".jpg", ".jpeg", ".dcm"] }, groupItems, description: "Single-frame images, one item per file" },
    ],
    renderers: [
      {
        id: "cornerstone-stack",
        consumes: [`${IMAGE2D}.dataKinds.raster`],
        space: "image2d",
        capabilities: ["cornerstone", "windowLevel", "zoom", "rotate", "holdToPan"],
        description: "Cornerstone3D stack viewport: window/level, invert, flip, rotate, magnifier, measurements, labelmaps",
      },
    ],
    commands: [{ id: "fitView", keys: ["0"], label: "Fit image to view", group: "View", description: "Reset zoom, pan and window" }],
    inspectors: [{ id: "main", geometries: "*", description: "Physical measurements (mm, mm², HU) for Cornerstone annotations" }],
    exporters: [
      { id: "coco", label: "COCO JSON", accepts: ["box", "polygon", "keypoint", "measurement", "mask", "class"], description: "Boxes, polygons, RLE masks and keypoints in COCO format (pixel coordinates), plus image-level class labels." },
    ],
  },
  load: () => import("./impl"),
});
