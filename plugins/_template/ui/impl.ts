import type { ModuleImpl } from "@studio/plugin-ui-sdk/module";
import { CountPanel } from "./panels/count";
import { CanvasRenderer } from "./renderer";

export default { renderers: { canvas: CanvasRenderer }, panels: { count: CountPanel } } satisfies ModuleImpl;
