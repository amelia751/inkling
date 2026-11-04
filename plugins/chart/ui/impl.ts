import type { ModuleImpl } from "@studio/plugin-ui-sdk/module";
import { SeriesRenderer } from "./SeriesRenderer";
import { SpecRenderer } from "./SpecRenderer";

export default { renderers: { series: SeriesRenderer, spec: SpecRenderer } } satisfies ModuleImpl;
