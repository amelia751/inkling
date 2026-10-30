import { defineModule } from "@/platform/module";
import { ns } from "@studio/plugin-contracts/naming";

/** DICOM SEG / SR writers, for any environment whose items are DICOM (Cornerstone renderers). */
export default defineModule({
  id: ns("dicom-export"),
  version: "1.0.0",
  title: "DICOM export",
  description: "Masks as DICOM SEG and measurements as DICOM SR (TID 1500), referencing the source DICOM images.",
  contributes: {
    exporters: [
      { id: "dicom-seg", label: "DICOM SEG (current item)", accepts: ["mask"], description: "Masks as a DICOM Segmentation object referencing the source DICOM images (one segment per label). DICOM inputs only." },
      { id: "dicom-sr", label: "DICOM SR measurements (current item)", accepts: ["measurement"], description: "Lengths, angles, ROIs, probes and arrows as a DICOM Structured Report (TID 1500). DICOM inputs only." },
    ],
  },
  load: () => import("./impl"),
});
