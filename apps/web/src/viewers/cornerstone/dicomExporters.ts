import { useStudio } from "@/stores/studio";
import type { ExportContext, Exporter } from "@/viewers/ViewerAdapter";

/**
 * DICOM SEG / SR exporters shared by the 2D and 3D adapters. Pure wrapper: the heavy
 * Cornerstone + adapters code is imported only when an export runs. Exports the item open
 * in the studio (or the first DICOM item with annotations); non-DICOM items are refused
 * with a message pointing to the NIfTI / COCO exports.
 */
function pickItem({ project, items, annotations }: ExportContext, kind: "mask" | "measure") {
  const wanted = (id: string) =>
    annotations.some((a) => a.itemId === id && (kind === "mask" ? a.geometry.type === "mask" : a.geometry.type !== "mask" && a.geometry.type !== "class"));
  const s = useStudio.getState();
  const current = s.projectId === project.id ? items[s.itemIndex] : undefined;
  const isDicom = (it: (typeof items)[number]) => it.assets.some((a) => /\.dcm$/i.test(a.path));
  if (current && isDicom(current) && wanted(current.id)) return current;
  return items.find((it) => isDicom(it) && wanted(it.id)) ?? current ?? items[0];
}

const hasDicom = (project: { assets: { path: string }[] }) => project.assets.some((a) => /\.dcm$/i.test(a.path));

export const dicomSegExporter: Exporter = {
  id: "dicom-seg",
  label: "DICOM SEG (current item)",
  description: "Masks as a DICOM Segmentation object referencing the source DICOM images (one segment per label). DICOM inputs only.",
  filename: (project) => `${project.id}-seg.dcm`,
  available: hasDicom,
  async build(ctx) {
    const item = pickItem(ctx, "mask");
    const m = await import("./dicomExport");
    return m.buildDicomSeg({ project: ctx.project, item, annotations: ctx.annotations });
  },
};

export const dicomSrExporter: Exporter = {
  id: "dicom-sr",
  label: "DICOM SR measurements (current item)",
  description: "Lengths, angles, ROIs, probes and arrows as a DICOM Structured Report (TID 1500). DICOM inputs only.",
  filename: (project) => `${project.id}-sr.dcm`,
  available: hasDicom,
  async build(ctx) {
    const item = pickItem(ctx, "measure");
    const m = await import("./dicomExport");
    return m.buildDicomSr({ project: ctx.project, item, annotations: ctx.annotations });
  },
};
