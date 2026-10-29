import { CardiacIcon } from "@/components/icons";
import { defineModule } from "@/platform/module";
import { modArrows } from "@/modules/core/manifest";
import type { Project, StudioItem } from "@/types";

export const CINE = "inkling.cine";
const core = (n: string) => `inkling.core.commands.${n}`;

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
  description: "4D (slice × frame) image series such as cardiac cine MRI: contours and masks per slice and frame, playback, copy-forward.",
  requires: ["inkling.overlay2d"],
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
        description: "One slice × frame at a time on a canvas, with a phase matrix, playback and function metrics",
      },
    ],
    commands: [
      { id: "fitView", keys: ["="], label: "Fit to view", group: "View", description: "Fit the image to the viewport" },
      { id: "stepFrame", keys: ["ArrowLeft", "ArrowRight"], display: "← →", label: "Previous or next frame", group: "Playback", repeat: true, shadows: [core("prevItem"), core("nextItem")], description: "Step one frame" },
      { id: "stepSlice", keys: ["ArrowUp", "ArrowDown"], display: "↑ ↓", label: "Previous or next slice", group: "Navigate", repeat: true, shadows: [core("prevItem"), core("nextItem")], description: "Step one slice" },
      { id: "copyContourReplace", keys: ["shift+alt+ArrowLeft", "shift+alt+ArrowRight", "shift+alt+ArrowUp", "shift+alt+ArrowDown"], display: modArrows("shift+alt"), label: "Copy contour, replacing what is at the target", group: "Drawing", description: "Copy the selected contours, replacing the target's" },
      { id: "copyContour", keys: ["alt+ArrowLeft", "alt+ArrowRight", "alt+ArrowUp", "alt+ArrowDown"], display: modArrows("alt"), label: "Copy contour to the next frame or slice", group: "Drawing", description: "Copy the selected contours to the neighbouring cell" },
    ],
    inspectors: [{ id: "main", geometries: "*", description: "Areas, perimeters and structure roles in mm" }],
    exporters: [
      { id: "acdc-nifti", label: "ACDC labelmap (NIfTI)", accepts: ["spline", "polygon", "mask"], description: "4D uint8 .nii.gz, 1 = RV, 2 = MYO, 3 = LV, on the cine's grid and orientation. Frames without contours are zero." },
      { id: "cine-metrics-csv", label: "Cardiac function (CSV)", accepts: ["spline", "polygon", "mask"], description: "Per-frame, per-slice RV/MYO/LV areas and volumes, plus EDV, ESV, SV, EF and LV mass (Simpson's method of discs)." },
      { id: "cine-contours-json", label: "Contours (JSON)", accepts: ["spline", "polygon"], description: "Every contour with its spline control points, densely sampled outline, slice, frame, area and source." },
    ],
  },
  load: () => import("./impl"),
});
