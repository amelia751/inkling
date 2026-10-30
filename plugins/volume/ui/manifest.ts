import { VolumeIcon } from "@studio/studio-ui/icons";
import { tool } from "@studio/studio-renderers/tool-catalog";
import { defineModule } from "@studio/plugin-ui-sdk/module";
import { volumeCommands } from "./commands";
import { mprConfigSchema } from "./config";
import { groupItems, VOLUME, VOLUME_KIND } from "./dataKind";
import { volumeGeometries } from "./geometries";
import { ns } from "@studio/plugin-contracts/naming";

export { VOLUME };

const MPR = `${VOLUME}.renderers.cornerstone-mpr`;

export default defineModule({
  id: VOLUME,
  version: "1.1.0",
  title: "3D volumes",
  description: "NIfTI and DICOM series on Cornerstone3D MPR viewports (axial / coronal / sagittal + 3D) with crosshairs, 3D labelmaps and measurements.",
  requires: [ns("cornerstone")],
  contributes: {
    dataKinds: [
      {
        id: "volume",
        label: "3D volume",
        icon: VolumeIcon,
        itemNoun: "subject",
        match: { ext: [".nii", ".nii.gz", ".dcm"] },
        groupItems,
        description: "Volumes grouped by subject; each subject's sequences (NIfTI) or series (DICOM) feed the sequence picker, `sequence: seg` is the read-only reference segmentation",
      },
    ],
    renderers: [
      {
        id: "cornerstone-mpr",
        consumes: [VOLUME_KIND],
        space: "volume",
        capabilities: ["cornerstone", "windowLevel", "zoom", "rotate", "holdToPan", "slices", "planes", "crosshairs"],
        configSchema: mprConfigSchema,
        description: "Cornerstone3D orthographic MPR with linked crosshairs and VOI, layouts 1×3, 1 + 2, single, 2×2 with 3D and 1 + 3D",
        example: { viewports: [{ name: "main", renderer: MPR, config: { layout: "mpr3d", layouts: ["mpr", "mpr3d", "plane3d"] } }] },
      },
    ],
    geometries: volumeGeometries,
    tools: [tool("point", { creates: "point3d", when: "renderer.space == volume", description: "3D landmark in voxel indices" })],
    commands: volumeCommands.map((c) => ({ ...c, when: c.when ? `renderer == ${MPR} && ${c.when}` : `renderer == ${MPR}` })),
    inspectors: [{ id: "main", geometries: "*", description: "Volumes (mL), lengths and ROI stats in patient space; HU for CT" }],
    exporters: [
      { id: "nifti-labelmap", label: "NIfTI labelmap (current subject)", accepts: ["mask"], description: "One .nii.gz labelmap of the subject open in the studio; geometry copied from its own scan. BraTS values 1/2/4, otherwise label index + 1." },
      { id: "masks-json", label: "Masks JSON (all subjects)", accepts: ["mask"], description: "Every subject's masks as run-length encoded voxel grids (x fastest, background first) with label values, voxel counts and volumes." },
    ],
  },
  load: () => import("./impl"),
});
