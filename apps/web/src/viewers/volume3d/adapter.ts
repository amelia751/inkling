import { lazy } from "react";
import type { ViewerAdapter } from "@/viewers/ViewerAdapter";
import { inspectAnnotation } from "@/viewers/cornerstone/inspect";
import { masksJsonExporter, niftiCurrentExporter } from "./niftiExport";

/** Cornerstone3D only loads when a volume project opens. */
const Volume3DViewer = lazy(() => import("./Volume3DViewer"));

export const volume3dAdapter: ViewerAdapter = {
  kind: "volume-3d",
  tools: [
    "select",
    "pan",
    "zoom",
    "windowLevel",
    "crosshairs",
    "brush",
    "eraser",
    "wand",
    "point",
    "length",
    "angle",
    "bidirectional",
    "ellipse",
    "box",
    "polygon",
    "freehand",
    "probe",
    "arrow",
  ],
  Component: Volume3DViewer,
  inspect: (a, { item }) => inspectAnnotation(a, { mode: "3d", modality: item.assets.some((x) => /\.dcm$/i.test(x.path)) ? undefined : "MR" }),
  exporters: [niftiCurrentExporter, masksJsonExporter],
};
