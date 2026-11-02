import { labelsFor, normalizeEnvironment, type EnvironmentSpec, type LabelGroup } from "@studio/contracts/environment";
import type { StudioItem } from "@studio/contracts/types";
import type { Registered } from "@/extension-host/registry";
import type { ResolvedEnv } from "@studio/plugin-ui-sdk/resolved";
import { unusableReason } from "@/extension-host/resolve";
import { inQueue, QUEUE_FILTERS, type ItemState, type QueueFilter } from "./item-folders";

/**
 * todo19 D7/D8: a Studio is a task over many kinds. Pure helpers that narrow labels, tools,
 * progress, review rules and exporters to one kind (the active item's, or each kind present).
 */

/** The item's data kind id; items grouped before todo19 fall back to the env's one kind. */
export function itemKind(env: Pick<ResolvedEnv, "dataKind"> | undefined, item: Pick<StudioItem, "dataKind"> | undefined): string | undefined {
  return item?.dataKind ?? env?.dataKind?.id;
}

/** Label groups for the active item (a group without `appliesTo` applies to every kind). */
export function labelsForItem(env: Pick<ResolvedEnv, "labels" | "dataKind">, item: Pick<StudioItem, "dataKind"> | undefined): LabelGroup[] {
  return labelsFor(env.labels, itemKind(env, item));
}

/** The label control a group uses, by name or id (what `resolve` checks geometries against). */
export type ControlLookup = (g: LabelGroup) => { geometries: string[] } | undefined;

/**
 * Tools for the active item: the resolver already dropped tools no label accepts; here a
 * drawing tool also needs an *applicable* label that uses its geometry. When every group
 * applies, `env.tools` is returned unchanged (same array, so memos hold).
 */
export function toolsForItem(
  env: Pick<ResolvedEnv, "labels" | "dataKind" | "tools">,
  item: Pick<StudioItem, "dataKind"> | undefined,
  control: ControlLookup,
): Registered<"tools">[] {
  const applicable = labelsForItem(env, item);
  if (!env.labels.length || applicable.length === env.labels.length) return env.tools;
  const controls = applicable.map(control);
  return env.tools.filter((t) => !unusableReason(t, controls));
}

export type QueueCounts = Record<QueueFilter, number>;
const zero = (): QueueCounts => Object.fromEntries(QUEUE_FILTERS.map((f) => [f.id, 0])) as QueueCounts;

/**
 * "To do / Needs review / Done" in total and per kind (D8). Only item counts: throughput units
 * (frames, slices) differ per kind and are never added up.
 */
export function queueCountsByKind(
  items: Pick<StudioItem, "dataKind">[],
  stateOf: (i: number) => ItemState,
  fallbackKind?: string,
): { total: QueueCounts; byKind: Record<string, QueueCounts> } {
  const total = zero();
  const byKind: Record<string, QueueCounts> = {};
  items.forEach((it, i) => {
    const s = stateOf(i);
    const k = it.dataKind ?? fallbackKind ?? "";
    const row = (byKind[k] ??= zero());
    for (const f of QUEUE_FILTERS) {
      if (!inQueue(s, f.id)) continue;
      total[f.id]++;
      row[f.id]++;
    }
  });
  return { total, byKind };
}

/** Accepted kinds: `accepts`, else the kinds the env maps (after normalising the shorthand). */
export function acceptedKinds(spec: EnvironmentSpec): string[] {
  return normalizeEnvironment(spec).accepts ?? [];
}

/** Per accepted kind: the profile's exporters ∪ the env's exporters, deduplicated, in order. */
export function exportersByKind(spec: EnvironmentSpec): Record<string, string[]> {
  const norm = normalizeEnvironment(spec);
  const out: Record<string, string[]> = {};
  for (const k of norm.accepts ?? []) out[k] = [...new Set([...(norm.data?.kinds?.[k]?.exporters ?? []), ...(spec.exporters ?? [])])];
  return out;
}

/** Every exporter id any accepted kind offers (the export page's list). */
export function exporterIds(spec: EnvironmentSpec): string[] {
  return [...new Set([...(spec.exporters ?? []), ...Object.values(exportersByKind(spec)).flat()])];
}

/** Per kind present in `items`: the review rule ids to run (env rules ∪ the profile's) and that kind's items. */
export function reviewRunsByKind<T extends Pick<StudioItem, "dataKind">>(
  spec: EnvironmentSpec,
  items: T[],
  fallbackKind?: string,
): { kind: string; ruleIds: string[]; items: T[] }[] {
  const norm = normalizeEnvironment(spec);
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = it.dataKind ?? fallbackKind ?? "";
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  return [...groups].map(([kind, list]) => ({
    kind,
    ruleIds: [...new Set([...(spec.reviewRules ?? []), ...(norm.data?.kinds?.[kind]?.reviewRules ?? [])])],
    items: list,
  }));
}

/** A folder name for a kind id (`studio.core.image2d` → `image2d`). */
export function kindFolder(kind: string): string {
  return (kind.split(".").at(-1) || "items").replace(/[^\w.-]+/g, "-");
}
