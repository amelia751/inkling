import type { ModuleImpl } from "@/platform/module";
import { useStudio } from "@/stores/studio";
import { exporters } from "./exporters";
import { inspectRows } from "./measure";
import { AdjustPanel } from "./panels/adjust";
import { CountsPanel } from "./panels/counts";
import { OsdRenderer } from "./renderer/Host";

export default {
  renderers: { osd: OsdRenderer },
  panels: { counts: CountsPanel, adjust: AdjustPanel },
  // mpp is what the renderer published for this item (config or the slide's own), never a module singleton.
  inspectors: { main: (a, { runtime }) => inspectRows(a, runtime.get<number | null>("mpp") ?? null, useStudio.getState().annotations) },
  exporters,
} satisfies ModuleImpl;
