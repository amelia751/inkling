import { CardiacIcon } from "@studio/ui/icons";
import { defineModule } from "@studio/plugin-ui-sdk/module";
import { modArrows } from "@studio/ui/keys";
import type { Project, StudioItem } from "@studio/contracts/types";
import { CineConfigSchema } from "./config";
import { cineGeometries } from "./geometries";
import { NS, ns } from "@studio/contracts/naming";

export const CINE = ns("cine");
const core = (n: string) => `${NS}.core.commands.${n}`;

/** The whole study (cine + reference segmentations) is one item. */
function groupItems(project: Project): StudioItem[] {
  const cine = project.assets.find((a) => a.role === "cine")?.path.split("/")[1];
  return [{
    id: cine ?? project.id,
    name: cine ?? "Study",
    group: "Studies",
    assets: project.assets,
    sourceLabel: project.meta?.group ? `${project.meta.group}` : undefined,
    dataKind: `${CINE}.dataKinds.volume-time`,
  }];
}

export default defineModule({
  id: CINE,
  version: "1.0.0",
  title: "Slice × frame cine",
  description: "Any slice × frame image series (4D NIfTI, e.g. cardiac cine MRI): contours and masks per slice and frame, key frames, playback, copy-forward, interpolation and reference import.",
  requires: [ns("overlay2d")],
  contributes: {
    dataKinds: [
      { id: "volume-time", label: "4D cine", icon: CardiacIcon, itemNoun: "study", match: { ext: [".nii", ".nii.gz"] }, groupItems, description: "A 4D series plus reference segmentations, as one study" },
    ],
    renderers: [
      {
        id: "slice-frame-canvas",
        consumes: [`${CINE}.dataKinds.volume-time`],
        space: "image2d",
        capabilities: ["time", "slices", "playback", "drafting", "holdToPan", "windowLevel"],
        description: "One slice × frame at a time on a canvas, with a slice × frame matrix, key frames and playback. Publishes runtime grid, playhead, references and coverage",
        configSchema: CineConfigSchema,
        example: {
          viewports: [
            {
              name: "main",
              renderer: `${CINE}.renderers.slice-frame-canvas`,
              config: { structures: { lv: "left ventricle" }, keyFrames: [{ id: "ED", label: "End-diastole" }, { id: "ES", label: "End-systole" }] },
            },
          ],
        },
      },
    ],
    commands: [
      { id: "fitView", keys: ["="], label: "Fit to view", group: "View", description: "Fit the image to the viewport" },
      { id: "stepFrame", keys: ["ArrowLeft", "ArrowRight"], display: "← →", label: "Previous or next frame", group: "Playback", repeat: true, shadows: [core("prevItem"), core("nextItem")], description: "Step one frame" },
      { id: "stepSlice", keys: ["ArrowUp", "ArrowDown"], display: "↑ ↓", label: "Previous or next slice", group: "Navigate", repeat: true, shadows: [core("prevItem"), core("nextItem")], description: "Step one slice" },
      { id: "copyContourReplace", keys: ["shift+alt+ArrowLeft", "shift+alt+ArrowRight", "shift+alt+ArrowUp", "shift+alt+ArrowDown"], display: modArrows("shift+alt"), label: "Copy contour, replacing what is at the target", group: "Drawing", description: "Copy the selected contours, replacing the target's" },
      { id: "copyContour", keys: ["alt+ArrowLeft", "alt+ArrowRight", "alt+ArrowUp", "alt+ArrowDown"], display: modArrows("alt"), label: "Copy contour to the next frame or slice", group: "Drawing", description: "Copy the selected contours to the neighbouring cell" },
      { id: "goTo", label: "Go to slice and frame", group: "Navigate", description: "Show a slice and frame; args { slice?, frame? } (0-based)" },
    ],
    geometries: cineGeometries,
    inspectors: [{ id: "main", geometries: "*", description: "Areas, perimeters and structure roles in mm (from runtime.grid); key frame names" }],
    exporters: [
      { id: "acdc-nifti", label: "ACDC labelmap (NIfTI)", accepts: ["spline", "polygon", "mask"], description: "4D uint8 .nii.gz on the cine's grid and orientation; value = label position (1 = RV, 2 = MYO, 3 = LV for ACDC labels). Frames without contours are zero." },
      { id: "cine-contours-json", label: "Contours (JSON)", accepts: ["spline", "polygon"], description: "Every contour with its spline control points, densely sampled outline, slice, frame, area and source." },
    ],
  },
  load: () => import("./impl"),
});
