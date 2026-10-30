import type { ModuleImpl } from "@studio/plugin-ui-sdk/module";
import { cineExporters } from "./exporters";
import { inspectCine } from "./inspect";
import { CineHost } from "./renderer/Host";

export default {
  renderers: { "slice-frame-canvas": CineHost },
  inspectors: { main: inspectCine },
  exporters: cineExporters,
} satisfies ModuleImpl;
