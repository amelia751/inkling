import { profileFor, type KindProfile } from "@studio/contracts";
import type { PanelSlot } from "@studio/plugin-ui-sdk/module";
import type { Registered, ResolvedEnv, ResolvedViewport } from "@studio/plugin-ui-sdk/resolved";
import type { StudioItem } from "@studio/contracts/types";

/**
 * The active item picks its view (todo19 D3): its kind's profile from `data.kinds`, or the
 * generic file view when the environment doesn't map that kind. Pure: lookups go through
 * `Lookup`, so tests pass a stub instead of the registry.
 */

/** Registry lookups the profile needs (a subset of `Registry`). */
export interface Lookup {
  get(type: "renderers", id: string): Registered<"renderers"> | undefined;
  get(type: "tools", id: string): Registered<"tools"> | undefined;
  get(type: "panels", id: string): Registered<"panels"> | undefined;
}

/** Profile key the shell keys the viewport on when an item has no mapped kind. */
export const FILE_VIEW = "file-view";

export interface ActiveProfile {
  /** Stable key: the kind id for a mapped kind, `FILE_VIEW` otherwise. A change remounts the viewer. */
  key: string;
  kind: string | undefined;
  profile: KindProfile | undefined;
}

/** The kind an item has: its own, else the environment's single kind. */
export function itemKindOf(env: Pick<ResolvedEnv, "spec" | "dataKind">, item: Pick<StudioItem, "dataKind"> | undefined): string | undefined {
  return item?.dataKind ?? env.spec.data?.kind ?? env.dataKind?.id;
}

/** The active item's profile (undefined profile → the generic file view). */
export function activeProfile(env: Pick<ResolvedEnv, "spec" | "dataKind">, item: Pick<StudioItem, "dataKind"> | undefined): ActiveProfile {
  const kind = itemKindOf(env, item);
  const profile = profileFor(env.spec, kind);
  return { key: profile?.renderer ? (kind as string) : FILE_VIEW, kind, profile: profile?.renderer ? profile : undefined };
}

const SLOTS: PanelSlot[] = ["left", "right", "bottom", "viewport-bar"];

/**
 * The environment as the active item's profile sees it: viewports, tools and panels from the
 * profile (profile lists win over the environment's when set), and a `when` context that names
 * the profile's renderer plus `item.kind` / `item.profile`, so commands bind per profile. The
 * environment's own kind keeps its resolved viewports (overrides already merged). An unmapped
 * kind gets no viewports: the shell shows the generic file view.
 */
export function envForProfile(env: ResolvedEnv, active: ActiveProfile, lookup: Lookup): ResolvedEnv & { showFileView: boolean } {
  const { profile, kind } = active;
  const ownKind = kind !== undefined && kind === (env.spec.data?.kind ?? env.dataKind?.id);
  let viewports: ResolvedViewport[] = [];
  if (profile) {
    const sameAsEnv = ownKind && !profile.viewports && env.viewports[0]?.renderer.id === profile.renderer;
    if (sameAsEnv) viewports = env.viewports;
    else {
      const specs = profile.viewports ?? [{ name: env.viewports[0]?.name ?? "main", renderer: profile.renderer, config: profile.config }];
      viewports = specs.flatMap((v) => {
        const renderer = lookup.get("renderers", v.renderer);
        return renderer ? [{ name: v.name, renderer, config: v.config ?? {} }] : [];
      });
    }
  }
  const unmapped = viewports.length === 0;
  // The generic file view renderer (packages/renderers) when it's registered; else the shell's fallback.
  if (unmapped && env.fileView) viewports = [env.fileView];
  const fileView = unmapped;
  const pick = <T extends "tools" | "panels">(type: T, ids: string[], fallback: Registered<T>[]): Registered<T>[] =>
    ids.flatMap((id) => {
      const known = fallback.find((c) => c.id === id) ?? (lookup.get(type as "tools", id) as Registered<T> | undefined);
      return known ? [known] : [];
    });
  const allPanels = SLOTS.flatMap((s) => env.panels[s] ?? []);
  const tools = fileView ? [] : profile?.tools ? pick("tools", profile.tools, env.tools) : env.tools;
  const panels = profile?.panels
    ? (Object.fromEntries(SLOTS.map((s) => [s, pick("panels", profile.panels?.[s] ?? [], allPanels)])) as ResolvedEnv["panels"])
    : env.panels;
  const vp = viewports[0];
  const context = {
    ...env.context,
    ...(vp ? { renderer: vp.renderer.id, "renderer.name": vp.renderer.name, "renderer.space": vp.renderer.space, "renderer.capabilities": vp.renderer.capabilities } : { renderer: undefined, "renderer.name": undefined, "renderer.space": undefined, "renderer.capabilities": [] }),
    "item.kind": kind,
    "item.profile": active.key,
  };
  return { ...env, viewports, tools, panels, context, showFileView: fileView && !env.fileView };
}
