import type { ModuleImpl } from "@/platform/module";
import { videoExporters } from "./exporters";
import { inspectVideo } from "./inspect";
import { VideoRenderer } from "./renderer/Host";
import { registerTrackShape } from "./trackShape";

registerTrackShape();

export default {
  renderers: { "frame-canvas": VideoRenderer },
  inspectors: { main: inspectVideo },
  exporters: videoExporters,
} satisfies ModuleImpl;
