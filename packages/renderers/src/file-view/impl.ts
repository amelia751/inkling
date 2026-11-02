import { lazy } from "react";
import type { ModuleImpl } from "@studio/plugin-ui-sdk/module";

export default { renderers: { file: lazy(() => import("./FileView")) } } satisfies ModuleImpl;
