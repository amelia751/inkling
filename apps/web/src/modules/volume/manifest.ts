import { VolumeIcon } from "@/components/icons";
import { tool } from "@/kits/tool-catalog";
import { defineModule } from "@/platform/module";
import type { Project, StudioItem } from "@/types";

export const VOLUME = "inkling.volume";

/** One item per subject; a subject's files (sequences, DICOM series, reference segmentations) travel together. */
function groupItems(project: Project): StudioItem[] {
  const bySubject = new Map<string, StudioItem>();
  for (const asset of project.assets) {
    const subject = asset.subject ?? "subject";
    const item = bySubject.get(subject) ?? { id: subject, name: subject, group: "Subjects", assets: [], dataKind: `${VOLUME}.dataKinds.volume` };
    item.assets.push(asset);
    bySubject.set(subject, item);
  }
  return [...bySubject.values()];
}

export default defineModule({
  id: VOLUME,
  version: "1.0.0",
  title: "3D volumes",
  description: "NIfTI and DICOM series on Cornerstone3D MPR viewports (axial / coronal / sagittal + 3D) with crosshairs, 3D labelmaps and measurements.",
  requires: ["inkling.cornerstone"],
  contributes: {
    dataKinds: [
      { id: "volume", label: "3D volume", icon: VolumeIcon, itemNoun: "subject", match: { ext: [".nii", ".nii.gz", ".dcm"] }, groupItems, description: "Volumes grouped by subject (several sequences per subject)" },
    ],
    renderers: [
      {
        id: "cornerstone-mpr",
        consumes: [`${VOLUME}.dataKinds.volume`],
        space: "volume",
        capabilities: ["cornerstone", "windowLevel", "zoom", "rotate", "holdToPan", "slices", "planes", "crosshairs"],
        description: "Cornerstone3D orthographic MPR with linked crosshairs and an optional 3D view",
      },
    ],
    tools: [tool("point", { creates: "point3d", when: "renderer.space == volume", description: "3D landmark in voxel indices" })],
    commands: [
      { id: "fitView", keys: ["="], label: "Fit to view", group: "View", description: "Reset every viewport" },
      { id: "stepSlice", keys: ["ArrowUp", "ArrowDown"], display: "↑ ↓", label: "Previous or next slice", group: "Navigate", repeat: true, shadows: ["inkling.core.commands.prevItem", "inkling.core.commands.nextItem"], description: "Scroll the active plane" },
      { id: "firstLastSlice", keys: ["Home", "End"], display: "Home / End", label: "First or last slice", group: "Navigate", description: "Jump to the first or last slice" },
    ],
    inspectors: [{ id: "main", geometries: "*", description: "Volumes (mL), lengths and ROI stats in patient space" }],
    exporters: [
      { id: "nifti-labelmap", label: "NIfTI labelmap (current subject)", accepts: ["mask"], description: "One .nii.gz labelmap of the subject open in the studio; geometry copied from its own scan. BraTS values 1/2/4, otherwise label index + 1." },
      { id: "masks-json", label: "Masks JSON (all subjects)", accepts: ["mask"], description: "Every subject's masks as run-length encoded voxel grids (x fastest, background first) with label values, voxel counts and volumes." },
    ],
  },
  load: () => import("./impl"),
});
