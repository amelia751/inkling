import type { ModuleImpl } from "@/platform/module";
import { DeclarativePanel } from "./panels/declarative";
import { SandboxPanel } from "./panels/sandbox";

export default { panels: { declarative: DeclarativePanel, sandbox: SandboxPanel } } satisfies ModuleImpl;
