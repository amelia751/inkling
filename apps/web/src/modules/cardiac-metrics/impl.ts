import type { ModuleImpl } from "@/platform/module";
import { metricsExporters } from "./exporters";
import { CardiacMetricsPanel } from "./panels/metrics";

export default { panels: { metrics: CardiacMetricsPanel }, exporters: metricsExporters } satisfies ModuleImpl;
