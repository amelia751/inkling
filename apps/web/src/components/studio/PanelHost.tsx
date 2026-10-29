import { useSyncExternalStore } from "react";
import type { PanelProps } from "@/platform/module";
import { registry } from "@/platform/registry";
import type { ResolvedEnv } from "@/platform/resolve";
import type { Project, StudioItem } from "@/types";

/** Renders one panel contribution by id (its module is preloaded with the environment). */
export function PanelHost({ id, env, project, items, item }: { id: string; env: ResolvedEnv; project: Project; items: StudioItem[]; item: StudioItem | undefined }) {
  useSyncExternalStore((l) => registry.subscribe(l), () => registry.version);
  const Panel = registry.peekImpl<React.ComponentType<PanelProps>>(id);
  if (!Panel) return null;
  return <Panel env={env} project={project} items={items} item={item} config={env.configs[id] ?? {}} />;
}
