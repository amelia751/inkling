import { useMemo, useSyncExternalStore } from "react";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import { registry } from "@/extension-host/registry";
import type { ResolvedEnv, ResolvedViewport } from "@/extension-host/resolve";
import { runtimeFor } from "@studio/plugin-ui-sdk/runtime";
import type { Project, StudioItem } from "@studio/contracts/types";

/**
 * Mounts one viewport's renderer. The renderer implementation comes from the registry
 * (lazy module load; the Studio preloads the environment's modules first), and receives
 * the environment, its merged config and a runtime scoped to the item.
 */
export function ViewportHost({ env, viewport, project, item }: { env: ResolvedEnv; viewport: ResolvedViewport; project: Project; item: StudioItem }) {
  useSyncExternalStore((l) => registry.subscribe(l), () => registry.version);
  const Renderer = registry.peekImpl<React.ComponentType<RendererProps>>(viewport.renderer.id);
  // Renderers read labels from the live environment, so agent label edits reach them.
  const scoped = useMemo(() => ({ ...project, labels: env.labels, environment: env.spec }), [project, env]);
  const runtime = useMemo(() => runtimeFor(item.id), [item.id]);
  if (!Renderer) return null;
  return <Renderer env={env} viewport={viewport} project={scoped} item={item} config={viewport.config} runtime={runtime} />;
}
