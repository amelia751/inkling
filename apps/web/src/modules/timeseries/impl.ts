import type { ModuleImpl } from "@/platform/module";
import { exporters } from "./exporters";
import { inspect } from "./inspect";
import { MeasurementsPanel } from "./panels/measurements";
import { StripChartHost } from "./renderer/Host";

export default {
  renderers: { "strip-chart": StripChartHost },
  panels: { measurements: MeasurementsPanel },
  inspectors: { main: inspect },
  exporters,
} satisfies ModuleImpl;
