import * as z from "zod";
import { SlideIcon } from "@/components/icons";
import { tool } from "@/kits/tool-catalog";
import { defineModule } from "@/platform/module";
import type { Project, StudioItem } from "@/types";

export const WSI = "inkling.wsi";
const ON_OSD = `renderer == ${WSI}.renderers.osd`;
const size = z.object({ size: z.number().int().min(2).max(120).default(16).describe("Diameter in screen pixels") });

function groupItems(project: Project): StudioItem[] {
  return project.assets
    .filter((a) => a.role !== "thumbnail")
    .map((a) => ({ id: a.path, name: a.slide ?? a.path, group: "Slides", assets: [a], dataKind: `${WSI}.dataKinds.raster-pyramid` }));
}

/**
 * Tiled image pyramids (whole-slide pathology, but also satellite or any DZI): deep zoom
 * with vector regions, cell points, magic wand and physical measurements from `mpp`.
 */
export default defineModule({
  id: WSI,
  version: "1.0.0",
  title: "Tiled image pyramids",
  description: "Deep-zoom image pyramids (DZI) on OpenSeadragon with vector regions, brush/eraser on regions, magic wand, point counting and µm measurements.",
  requires: ["inkling.overlay2d"],
  contributes: {
    dataKinds: [
      { id: "raster-pyramid", label: "Whole-slide", icon: SlideIcon, itemNoun: "slide", match: { ext: [".dzi", ".svs", ".tiff"] }, groupItems, description: "One item per pyramid (slide); thumbnails are skipped" },
    ],
    renderers: [
      {
        id: "osd",
        consumes: [`${WSI}.dataKinds.raster-pyramid`],
        space: "image2d",
        capabilities: ["pan", "zoom", "rotate", "overlay", "drafting", "vertexUndo", "holdToPan"],
        description: "OpenSeadragon deep zoom with a vector overlay, navigator and colour adjustments",
      },
    ],
    tools: [
      tool("brush", { creates: "multipolygon", when: ON_OSD, optionsSchema: size, description: "Paint vector regions with the active label" }),
      tool("eraser", { creates: "multipolygon", when: ON_OSD, optionsSchema: size, description: "Erase from vector regions" }),
      tool("wand", { creates: "polygon", when: ON_OSD, description: "Magic wand on tile pixels" }),
      tool("mark", { creates: "keypoint", when: ON_OSD, description: "Point (cell) counting" }),
      tool("length", { creates: "polyline", when: ON_OSD, description: "Distance in µm" }),
    ],
    commands: [{ id: "toggleClassNames", keys: ["n"], label: "Show or hide class names", group: "View", description: "Toggle class names on regions" }],
    inspectors: [{ id: "main", geometries: "*", description: "Areas and lengths in µm from the slide's mpp" }],
    exporters: [
      { id: "qupath-geojson", label: "QuPath GeoJSON", accepts: ["polygon", "multipolygon", "keypoint", "mark", "polyline", "box", "ellipse"], description: "Regions, lines and per-class point sets in level-0 pixels with classifications and measurements. Opens in QuPath (File › Import objects), Cytomine and DSA." },
      { id: "asap-xml", label: "ASAP XML", accepts: ["polygon", "multipolygon", "keypoint", "mark", "box"], description: "ASAP / CAMELYON annotation XML: polygons, rectangles, point sets and groups per class; holes become <class>_exclusion polygons." },
      { id: "point-counts-csv", label: "Cell counts CSV", accepts: ["keypoint", "mark"], description: "Per-slide, per-class point counts with region count, region area and points/mm²." },
    ],
  },
  load: () => import("./impl"),
});
