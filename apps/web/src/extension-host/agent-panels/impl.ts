import type { ModuleImpl } from "@studio/plugin-ui-sdk/module";
import { DeclarativePanel } from "./panels/declarative";
import { SandboxPanel } from "./panels/sandbox";

export default { panels: { declarative: DeclarativePanel, sandbox: SandboxPanel } } satisfies ModuleImpl;
