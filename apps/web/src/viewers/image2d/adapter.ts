import { lazy } from "react";
import type { ViewerAdapter } from "@/viewers/ViewerAdapter";
import { inspectAnnotation } from "@/viewers/cornerstone/inspect";
import { dicomSegExporter, dicomSrExporter } from "@/viewers/cornerstone/dicomExporters";
import { cocoExporter } from "./coco";

/** Cornerstone3D only loads when a 2D project opens. */
const Image2DViewer = lazy(() => import("./Image2DViewer"));

export const image2dAdapter: ViewerAdapter = {
  kind: "image-2d",
  tools: [
    "select",
    "pan",
    "zoom",
    "windowLevel",
    "box",
    "ellipse",
    "polygon",
    "freehand",
    "keypoint",
    "length",
    "angle",
    "cobb",
    "bidirectional",
    "probe",
    "arrow",
    "brush",
    "eraser",
    "wand",
  ],
  Component: Image2DViewer,
  inspect: (a) => inspectAnnotation(a, { mode: "2d" }),
  exporters: [cocoExporter, dicomSegExporter, dicomSrExporter],
};
