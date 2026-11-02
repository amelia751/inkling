import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import type { ResolvedEnv } from "@/extension-host/resolve";
import type { Project, StudioItem } from "@studio/contracts/types";
import { ModuleSlot } from "./ModuleSlot";

/** Renders one panel contribution by id: a skeleton while its module loads, its own error card if it fails. */
export function PanelHost({ id, env, project, items, item, standalone }: { id: string; env: ResolvedEnv; project: Project; items: StudioItem[]; item: StudioItem | undefined; standalone?: boolean }) {
  return (
    <ModuleSlot<React.ComponentType<PanelProps>> id={id} kind="panel" standalone={standalone}>
      {(Panel) => <Panel env={env} project={project} items={items} item={item} config={env.configs[id] ?? {}} />}
    </ModuleSlot>
  );
}
