import { useMemo } from "react";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import type { ResolvedEnv, ResolvedViewport } from "@/extension-host/resolve";
import { runtimeFor } from "@studio/plugin-ui-sdk/runtime";
import type { Project, StudioItem } from "@studio/contracts/types";
import { ModuleSlot } from "./ModuleSlot";

/**
 * A renderer that declares this capability keeps one engine instance across items: the shell
 * passes the new `item` instead of remounting it (todo11 Milestone 1 §4).
 */
export const ITEM_SWAP = "itemSwap";

/** Whether the shell should remount this viewport's renderer when the item changes. */
export const remountsOnItemSwitch = (viewport: ResolvedViewport): boolean => !viewport.renderer.capabilities.includes(ITEM_SWAP);

/**
 * Mounts one viewport's renderer. The implementation comes from the registry (its module loads
 * on first use, behind a canvas-shaped skeleton), and receives the environment, its merged
 * config and a runtime scoped to the item.
 */
export function ViewportHost({ env, viewport, project, item }: { env: ResolvedEnv; viewport: ResolvedViewport; project: Project; item: StudioItem }) {
  // Renderers read labels from the live environment, so agent label edits reach them.
  const scoped = useMemo(() => ({ ...project, labels: env.labels, environment: env.spec }), [project, env]);
  const runtime = useMemo(() => runtimeFor(item.id), [item.id]);
  return (
    <ModuleSlot<React.ComponentType<RendererProps>> id={viewport.renderer.id} kind="viewport">
      {(Renderer) => <Renderer env={env} viewport={viewport} project={scoped} item={item} config={viewport.config} runtime={runtime} />}
    </ModuleSlot>
  );
}
