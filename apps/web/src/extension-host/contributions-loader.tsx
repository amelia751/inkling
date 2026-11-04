import { mediaTypeOf } from "@studio/contracts/media-types";
import { itemWhenContext, profileForItem } from "./resolve";
import type { PluginManifest } from "@studio/contracts/plugin-manifest";
import type { PanelDecl, RendererDecl, UiContributions, VisibleWhen } from "@studio/contracts/ui-contributions";
import { defineModule, type CommandContribution, type ModuleManifest, type PanelContribution, type PanelProps, type RendererContribution, type RendererProps, type ResolvedEnv } from "@studio/plugin-ui-sdk";
import { FILES_KIND, GENERIC } from "./sandbox/manifest";
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
function trustedPanel(pluginId: string, p: PanelDecl) {
  const r = trustedRenderer(p.renderer);
  function DeclaredPanel(props: PanelProps) {
    if (!r) return <RendererUnavailable name={p.renderer} />;
    const config = r.configSchema ? (r.configSchema.safeParse({ ...p.config, ...props.config }).data as Record<string, unknown> | undefined) : { ...p.config, ...props.config };
    if (!config) return <RendererUnavailable name={p.renderer} reason="its config is invalid" />;
    const Component = r.component;
    const rendererProps: TrustedRendererProps = { ...props, config, binding: p.dataBinding, pluginId };
    return <Component {...rendererProps} />;
  }
  DeclaredPanel.displayName = `DeclaredPanel(${p.renderer})`;
  return DeclaredPanel;
}

/** A viewport on a named trusted renderer that can fill one (todo10 rung 4); others fail closed. */
function trustedViewport(pluginId: string, d: RendererDecl) {
  const r = trustedRenderer(d.renderer);
  function DeclaredViewport(props: RendererProps) {
    if (!r?.viewport) return <RendererUnavailable name={d.renderer} reason={r ? "it can't fill a viewport" : undefined} />;
    const config = r.configSchema ? (r.configSchema.safeParse({ ...d.config, ...props.config }).data as Record<string, unknown> | undefined) : { ...d.config, ...props.config };
    if (!config) return <RendererUnavailable name={d.renderer} reason="its config is invalid" />;
    const Viewport = r.viewport;
    return <Viewport {...props} config={config} pluginId={pluginId} />;
  }
  DeclaredViewport.displayName = `DeclaredViewport(${d.renderer})`;
  return DeclaredViewport;
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
  // Keyboard commands the plugin's trusted panels handle (useCommands under the plugin's id).
  for (const c of ui.commands ?? []) commands.push({ id: c.id, label: c.title, group: "Edit", keys: c.keys, when: whenFrom(c.visibleWhen), description: c.description ?? c.title });
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
  const decls = ui.renderers ?? [];
  const renderers: RendererContribution[] = decls.map((d) => ({
    id: d.id,
    consumes: d.consumes?.length ? d.consumes : [FILES_KIND],
    space: d.space,
    capabilities: d.capabilities,
    description: d.description ?? d.title ?? `${d.renderer} viewer`,
  }));
  const impl = { panels: Object.fromEntries(ui.panels.map((p) => [p.id, trustedPanel(m.id, p)])), renderers: Object.fromEntries(decls.map((d) => [d.id, trustedViewport(m.id, d)])) };
  return defineModule({
    id: m.id,
    version: m.version,
    title: m.name,
    description: m.description ?? m.name,
    ambient: true,
    // Viewers consume the generic files kind, so it comes along.
    ...(renderers.length ? { requires: [GENERIC] } : {}),
    contributes: { commands, panels, renderers },
    load: async () => impl,
  });
}

/** Every renderer name a contributions file uses that the host doesn't have. */
export function unknownRenderers(ui: UiContributions): string[] {
  return [...ui.panels.map((p) => p.renderer), ...(ui.renderers ?? []).map((r) => r.renderer)].filter((r) => !trustedRenderer(r));
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
export function visibleToolbarCommands(env: ResolvedEnv, item: { assets: { path: string; role?: string }[]; dataKind?: string } | undefined, live: Record<string, unknown>) {
  const ctx = { ...(profileForItem(env, item)?.context ?? env.context), ...live, "item.mediaType": itemMediaType(item), ...itemWhenContext(env, item) };
  return env.commands.filter((c) => c.surface === "toolbar" && when(c.when, ctx));
}

// ---- Fetch-and-hash (todo10 Phase 3) -----------------------------------------------------------

/** Folders the package tree digest skips (same list as `studio_signing.oci.EXCLUDE_DIRS`). */
const TREE_EXCLUDE = new Set(["node_modules", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".data"]);

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** The package tree digest from `{path: sha256 hex}`: sha256 over sorted `<path>\0<hex>\n` lines. */
export async function treeDigestOfHashes(hashes: Record<string, string>): Promise<string> {
  const lines = Object.keys(hashes)
    .filter((rel) => !rel.split("/").some((p) => TREE_EXCLUDE.has(p)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((rel) => `${rel}\0${hashes[rel]}\n`)
    .join("");
  return `sha256:${await sha256Hex(lines)}`;
}

/** What `GET /v1/plugins/{id}/files` returns. */
export interface PackageFiles {
  id: string;
  version: string;
  artifactDigest: string;
  manifestDigest?: string | null;
  signer?: string;
  hashes: Record<string, string>;
  files: Record<string, string>;
}

export type VerifiedPackage = { ok: true; files: Record<string, string> } | { ok: false; reason: string; expected?: string; got?: string };

const b64bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Check fetched package bytes against the digest the workspace pinned (never against a digest
 * the same response supplies): every returned file must hash to its entry in `hashes`, and the
 * tree digest recomputed from `hashes` must equal `pinned`. Returns the files as text.
 */
export async function verifyPackage(pkg: PackageFiles, pinned: string | null | undefined): Promise<VerifiedPackage> {
  if (!pinned) return { ok: false, reason: "the workspace has no pinned digest for this plugin" };
  const got = await treeDigestOfHashes(pkg.hashes ?? {});
  if (got !== pinned) return { ok: false, reason: "package tree digest isn't the pinned one", expected: pinned, got };
  const out: Record<string, string> = {};
  for (const [rel, b64] of Object.entries(pkg.files ?? {})) {
    const bytes = b64bytes(b64);
    const h = await sha256Hex(bytes);
    if (h !== pkg.hashes[rel]) return { ok: false, reason: `${rel} doesn't match its hash`, expected: pkg.hashes[rel], got: h };
    out[rel] = new TextDecoder().decode(bytes);
  }
  return { ok: true, files: out };
}
