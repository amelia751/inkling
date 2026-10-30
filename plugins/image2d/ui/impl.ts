import { lazy } from "react";
import { inspectAnnotation } from "@studio/renderers/cornerstone/inspect";
import type { ModuleImpl } from "@studio/plugin-ui-sdk/module";
import { cocoExporter } from "./exporters";
import { ViewControlsPanel } from "./panels/viewControls";

/** Cornerstone3D only loads when a stack viewport mounts; the canvas renderer is light but lazy too. */
const CornerstoneStackHost = lazy(() => import("./renderer/Host"));
const CanvasRasterHost = lazy(() => import("./renderer/canvas/Host"));

export default {
  renderers: { "cornerstone-stack": CornerstoneStackHost, "canvas-raster": CanvasRasterHost },
  panels: { viewControls: ViewControlsPanel },
  inspectors: { main: (a) => inspectAnnotation(a, { mode: "2d" }) },
  exporters: { coco: cocoExporter },
} satisfies ModuleImpl;
