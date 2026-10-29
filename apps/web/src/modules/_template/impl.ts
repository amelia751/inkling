import type { ModuleImpl } from "@/platform/module";
import { CountPanel } from "./panels/count";
import { CanvasRenderer } from "./renderer";

export default { renderers: { canvas: CanvasRenderer }, panels: { count: CountPanel } } satisfies ModuleImpl;
