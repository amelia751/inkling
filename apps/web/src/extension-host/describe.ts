import type { Annotation } from "@studio/plugin-contracts/types";
import type { InspectFn, InspectContext } from "@studio/plugin-ui-sdk/module";
import { registry } from "./registry";
import type { ResolvedEnv } from "./resolve";

/**
 * One line describing an annotation's geometry ("Box 120×80px · frame 3"), from the
 * geometry contribution for its type. Module geometries registered later refine core ones.
 */
export function describeGeometry(a: Annotation, env?: ResolvedEnv | null): string {
  const type = a.geometry.type;
  const candidates = (env?.geometries ?? registry.list("geometries")).filter((g) => g.type === type && g.describe);
  const g = candidates[candidates.length - 1] ?? registry.geometry(type);
  if (g?.describe) return g.describe(a.geometry, a);
  const name = type.charAt(0).toUpperCase() + type.slice(1);
  // A module type (`<module>.<name>`) whose plugin this workspace doesn't run: kept and
  // shown, never dropped (docs/plugins.md §14 #9).
  return !g && type.includes(".") ? `${name} (unavailable type)` : name;
}

/**
 * Inspector rows for an annotation: every inspector in the environment whose geometries
 * include the annotation's type contributes rows, in module order. Implementations must
 * be loaded (the Studio preloads the environment's modules).
 */
export function inspectRows(a: Annotation, env: ResolvedEnv, ctx: Omit<InspectContext, "env">): [string, string][] {
  const rows: [string, string][] = [];
  for (const ins of env.inspectors) {
    if (ins.geometries !== "*" && !ins.geometries.includes(a.geometry.type)) continue;
    const fn = registry.peekImpl<InspectFn>(ins.id);
    if (fn) rows.push(...fn(a, { ...ctx, env }));
  }
  return rows;
}
