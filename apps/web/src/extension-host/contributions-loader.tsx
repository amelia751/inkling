import { mediaTypeOf } from "@studio/contracts/media-types";
import type { PluginManifest } from "@studio/contracts/plugin-manifest";
import type { PanelDecl, UiContributions, VisibleWhen } from "@studio/contracts/ui-contributions";
import { defineModule, type CommandContribution, type ModuleManifest, type PanelContribution, type PanelProps, type ResolvedEnv } from "@studio/plugin-ui-sdk";
import { registerCommand } from "./commands";
import { dispatch } from "./gateway";
import { SURFACE_PLACEMENT } from "./surfaces";
import { when } from "./when";
import { trustedRenderer, type TrustedRendererProps } from "./trusted-renderers";

/**
 * Turns a plugin's `ui/contributions.json` into registry contributions under the plugin's
 * id (todo2 §2.3), so a plugin with no React of its own still gets toolbar buttons and
 * panels. Toolbar actions become command contributions (`surface: "toolbar"`, `when` from
 * `visibleWhen`) whose handler goes through the command gateway; panels become panel
 * contributions rendered by a named trusted renderer. The module is ambient: it joins every
 * environment while the plugin is active.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** `visibleWhen` → a `when` clause over the Studio context (`item.mediaType`, `selection.count`). */
export function whenFrom(v: VisibleWhen | undefined): string | undefined {
  if (!v) return undefined;
  const parts: string[] = [];
  if (v.assetMediaType?.length) {
    const alts = v.assetMediaType.map((t) => (t.endsWith("/*") ? `${escapeRe(t.slice(0, -1))}.*` : escapeRe(t)));
    parts.push(`item.mediaType =~ /^(?:${alts.join("|")})$/`);
  }
  if (v.selection) parts.push("selection.count > 0");
  if (v.when) parts.push(`(${v.when})`);
  return parts.length ? parts.join(" && ") : undefined;
}

/** Media type of an item (its first non-thumbnail asset), for `item.mediaType`. */
export function itemMediaType(item: { assets: { path: string; role?: string }[] } | undefined): string | undefined {
  const a = item?.assets.find((x) => x.role !== "thumbnail") ?? item?.assets[0];
  return a ? mediaTypeOf(a.path) : undefined;
}

/** A panel whose component is the named trusted renderer; unknown names fail closed. */
function trustedPanel(p: PanelDecl) {
  const r = trustedRenderer(p.renderer);
  function DeclaredPanel(props: PanelProps) {
    if (!r) return <RendererUnavailable name={p.renderer} />;
    const config = r.configSchema ? (r.configSchema.safeParse({ ...p.config, ...props.config }).data as Record<string, unknown> | undefined) : { ...p.config, ...props.config };
    if (!config) return <RendererUnavailable name={p.renderer} reason="its config is invalid" />;
    const Component = r.component;
    const rendererProps: TrustedRendererProps = { ...props, config, binding: p.dataBinding };
    return <Component {...rendererProps} />;
  }
  DeclaredPanel.displayName = `DeclaredPanel(${p.renderer})`;
  return DeclaredPanel;
}

export function RendererUnavailable({ name, reason }: { name: string; reason?: string }) {
  return (
    <div role="note" data-testid="renderer-unavailable" className="p-3 text-sm text-muted-foreground">
      Renderer “{name}” is not available{reason ? `: ${reason}` : ""}. Plugins can only use the Studio’s trusted renderers.
    </div>
  );
}

export function declarativeModule(m: Pick<PluginManifest, "id" | "version" | "name" | "description">, ui: UiContributions): ModuleManifest {
  const commands: CommandContribution[] = ui.toolbarActions.map((a) => ({
    id: a.id,
    label: a.title,
    group: "Edit",
    keys: a.keys,
    when: whenFrom(a.visibleWhen),
    description: a.description ?? a.title,
    surface: SURFACE_PLACEMENT[a.surface].kind === "toolbar" ? "toolbar" : undefined,
    iconName: a.icon,
    run: { command: a.command, args: a.args },
  }));
  const panels: PanelContribution[] = ui.panels.map((p) => {
    const place = SURFACE_PLACEMENT[p.surface];
    return {
      id: p.id,
      title: p.title ?? p.id,
      slot: place.kind === "panel" ? place.slot : "right",
      description: p.description ?? `${p.renderer} panel`,
      autoInclude: true,
      when: whenFrom(p.visibleWhen),
    };
  });
  const impl = { panels: Object.fromEntries(ui.panels.map((p) => [p.id, trustedPanel(p)])) };
  return defineModule({
    id: m.id,
    version: m.version,
    title: m.name,
    description: m.description ?? m.name,
    ambient: true,
    contributes: { commands, panels },
    load: async () => impl,
  });
}

/** Every renderer name a contributions file uses that the host doesn't have. */
export function unknownRenderers(ui: UiContributions): string[] {
  return ui.panels.map((p) => p.renderer).filter((r) => !trustedRenderer(r));
}

/**
 * Bind handlers for the environment's declarative commands (those with `run`): each sends
 * its command through the gateway with the current item as context. Returns the cleanup.
 */
export function bindDeclarativeCommands(env: ResolvedEnv, context: () => { itemId?: string; assetIds?: string[]; selection?: string[] }): () => void {
  const offs = env.commands
    .filter((c) => c.run)
    .map((c) =>
      registerCommand(c.id, () => {
        void dispatch(c.run!.command, c.run!.args ?? {}, context()).then((r) => {
          if (!r.ok) console.warn(`[gateway] ${c.run!.command}: ${r.error}`);
        });
        return true;
      }),
    );
  return () => offs.forEach((off) => off());
}

/** The environment's toolbar commands whose `when` holds for this item right now. */
export function visibleToolbarCommands(env: ResolvedEnv, item: { assets: { path: string; role?: string }[] } | undefined, live: Record<string, unknown>) {
  const ctx = { ...env.context, ...live, "item.mediaType": itemMediaType(item) };
  return env.commands.filter((c) => c.surface === "toolbar" && when(c.when, ctx));
}
