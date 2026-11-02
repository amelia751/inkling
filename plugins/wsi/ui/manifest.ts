import * as z from "zod";
import { SlideIcon } from "@studio/ui/icons";
import { tool } from "@studio/renderers/tool-catalog";
import { defineModule, type GeometryContribution } from "@studio/plugin-ui-sdk/module";
import type { Geometry, Project, StudioItem } from "@studio/contracts/types";
import { ns } from "@studio/contracts/naming";

export const WSI = ns("wsi");
const ON_OSD = `renderer == ${WSI}.renderers.osd`;
const size = z.object({ size: z.number().int().min(2).max(120).default(16).describe("Diameter in screen pixels") });
const tolerance = z.object({ tolerance: z.number().int().min(4).max(100).default(28).describe("Colour tolerance. Shift-click adds to the selected region, Alt-click subtracts") });

export const WsiConfigSchema = z.object({
  objective: z.number().positive().optional().describe("Scanner objective (×) for the magnification buttons; default from the asset, else 40"),
  mpp: z.number().positive().optional().describe("Physical units per level-0 pixel (µm for slides); default from the asset"),
  showNavigator: z.boolean().default(true).describe("Overview navigator in the bottom-right corner"),
});
export type WsiConfig = z.infer<typeof WsiConfigSchema>;

function groupItems(project: Project): StudioItem[] {
  return project.assets
    .filter((a) => a.role !== "thumbnail")
    .map((a) => ({ id: a.path, name: a.slide ?? a.path, group: "Slides", assets: [a], dataKind: `${WSI}.dataKinds.raster-pyramid` }));
}

/** Cell points are core `keypoint`s (v1 `mark`), described the way pathologists read them. */
const geometries: GeometryContribution[] = [
  {
    id: "keypoint",
    type: "keypoint",
    spaces: ["image2d"],
    description: "A counted point (cell) on a slide, in level-0 pixels",
    describe: (g: Geometry) => (g.type === "keypoint" ? `Point · ${Math.round(g.x)}, ${Math.round(g.y)}` : "Point"),
  },
];

/**
 * Tiled image pyramids (whole-slide pathology, but also satellite or any DZI): deep zoom
 * with vector regions, cell points, magic wand and physical measurements from `mpp`.
 */
export default defineModule({
  id: WSI,
  version: "1.1.0",
  title: "Tiled image pyramids",
  description: "Deep-zoom image pyramids (DZI) on OpenSeadragon with vector regions, brush/eraser on regions, magic wand, point counting and µm measurements.",
  requires: [ns("overlay2d")],
  contributes: {
    dataKinds: [
      { id: "raster-pyramid", label: "Whole-slide", icon: SlideIcon, itemNoun: "slide", match: { ext: [".dzi", ".svs", ".tiff", ".tif", ".ndpi", ".mrxs"] }, fileKinds: ["slide"], groupItems, description: "One item per pyramid (slide); thumbnails are skipped" },
    ],
    renderers: [
      {
        id: "osd",
        consumes: [`${WSI}.dataKinds.raster-pyramid`],
        space: "image2d",
        capabilities: ["pan", "zoom", "rotate", "overlay", "drafting", "vertexUndo", "holdToPan"],
        description: "OpenSeadragon deep zoom with the overlay2d vector engine, navigator and colour adjustments",
        configSchema: WsiConfigSchema,
        example: { viewports: [{ name: "main", renderer: `${WSI}.renderers.osd`, config: { mpp: 0.5, showNavigator: true } }] },
      },
    ],
    geometries,
    tools: [
      tool("brush", { creates: "multipolygon", when: ON_OSD, optionsSchema: size, description: "Paint vector regions with the active label" }),
      tool("eraser", { creates: "multipolygon", when: ON_OSD, optionsSchema: size, description: "Erase from vector regions" }),
      tool("wand", { creates: "polygon", when: ON_OSD, optionsSchema: tolerance, description: "Magic wand on tile pixels" }),
      tool("mark", { creates: "keypoint", when: ON_OSD, description: "Point (cell) counting" }),
      tool("length", { creates: "measurement", when: ON_OSD, description: "Distance in µm" }),
    ],
    commands: [
      { id: "toggleClassNames", keys: ["n"], label: "Show or hide class names", group: "View", when: ON_OSD, shadows: [ns("core.commands.nextTodo")], description: "Toggle class names on regions (takes N from Next to do)" },
      { id: "importGeoJSON", label: "Import QuPath GeoJSON", group: "Edit", when: ON_OSD, description: "Pick a GeoJSON file (QuPath, Cytomine, DSA) and add its objects to the current slide as one undo step" },
    ],
    panels: [
      { id: "counts", title: "Points", slot: "right", description: "Point counts per class on the slide, and inside the selected region with density per mm²" },
      { id: "adjust", title: "Adjust", slot: "viewport-bar", description: "Brightness, contrast, gamma and saturation of the slide tiles (display only; the wand samples them)" },
    ],
    inspectors: [{ id: "main", geometries: "*", description: "Areas and lengths in µm from the runtime's `mpp`, and points inside regions" }],
    exporters: [
      { id: "qupath-geojson", label: "QuPath GeoJSON", accepts: ["polygon", "multipolygon", "keypoint", "polyline", "measurement", "box", "ellipse"], description: "Regions, lines and per-class point sets in level-0 pixels with classifications and measurements. Opens in QuPath (File › Import objects), Cytomine and DSA." },
      { id: "asap-xml", label: "ASAP XML", accepts: ["polygon", "multipolygon", "keypoint", "polyline", "measurement", "box", "ellipse"], description: "ASAP / CAMELYON annotation XML: polygons, rectangles, point sets and groups per class; holes become <class>_exclusion polygons." },
      { id: "point-counts-csv", label: "Cell counts CSV", accepts: ["keypoint"], description: "Per-slide, per-class point counts with region count, region area and points/mm²." },
    ],
  },
  load: () => import("./impl"),
});
