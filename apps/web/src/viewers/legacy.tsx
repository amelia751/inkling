import type { ModuleImpl, RendererProps } from "@/platform/module";
import type { ViewerAdapter } from "./ViewerAdapter";

/**
 * Phase-3 shim: expose an existing ViewerAdapter as a module implementation (one renderer,
 * one catch-all inspector, its exporters) so the shell runs on the platform before each
 * viewer is rewritten. Removed per viewer as it converts (todo phase 6).
 */
export function legacyImpl(adapter: ViewerAdapter, renderer: string): ModuleImpl {
  const Viewer = adapter.Component;
  function LegacyRenderer({ project, item }: RendererProps) {
    return <Viewer project={project} item={item} />;
  }
  LegacyRenderer.displayName = `Legacy(${adapter.kind})`;
  return {
    renderers: { [renderer]: LegacyRenderer },
    inspectors: adapter.inspect ? { main: (a, ctx) => adapter.inspect!(a, { project: ctx.project, item: ctx.item }) } : {},
    exporters: Object.fromEntries((adapter.exporters ?? []).map((e) => [e.id, e])),
  };
}
