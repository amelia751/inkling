import { useSyncExternalStore } from "react";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { registry } from "@/extension-host/registry";
import type { ResolvedEnv } from "@/extension-host/resolve";
import type { Project, StudioItem } from "@studio/contracts/types";

/** Renders one panel contribution by id (its module is preloaded with the environment). */
export function PanelHost({ id, env, project, items, item }: { id: string; env: ResolvedEnv; project: Project; items: StudioItem[]; item: StudioItem | undefined }) {
  useSyncExternalStore((l) => registry.subscribe(l), () => registry.version);
  const Panel = registry.peekImpl<React.ComponentType<PanelProps>>(id);
  if (!Panel) return null;
  return <Panel env={env} project={project} items={items} item={item} config={env.configs[id] ?? {}} />;
}
