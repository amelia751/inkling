import { inspectAnnotation } from "@/kits/cornerstone/inspect";
import type { InspectFn, ModuleImpl } from "@/platform/module";
import { masksJsonExporter, niftiLabelmapExporter } from "./exporters";
import { MprRenderer } from "./renderer/Host";

/** Values in physical units; the modality the renderer published decides HU for CT. */
const inspect: InspectFn = (a, { item, runtime }) => {
  const published = runtime?.get<{ modality?: string }>("volume")?.modality;
  // Before the volume is open, fall back to the file type (NIfTI subjects are MR).
  const modality = published ?? (item.assets.some((x) => /\.dcm$/i.test(x.path)) ? undefined : "MR");
  return inspectAnnotation(a, { mode: "3d", modality });
};

export default {
  renderers: { "cornerstone-mpr": MprRenderer },
  inspectors: { main: inspect },
  exporters: { "nifti-labelmap": niftiLabelmapExporter, "masks-json": masksJsonExporter },
} satisfies ModuleImpl;
