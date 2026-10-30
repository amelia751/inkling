import type { Annotation, Geometry } from "@studio/contracts/types";
import { bboxOverlap, geometryFromRegion, isRegion, regionArea, regionOf, ringsBounds, subtractRegion, unionRegions, type BBox, type Region } from "../regions";
import type { RegionOp, ToolContext } from "./types";

/**
 * Merge a painted / wand region into the store. add: union into `target` (or a new
 * annotation with the active label); subtract: cut from `target`, or from every editable
 * region of the active label it overlaps. Regions that vanish are removed, and every cut
 * lands as ONE undo step.
 */
export function applyRegion(ctx: Pick<ToolContext, "store" | "scene" | "view" | "editable" | "create">, region: Region, op: RegionOp, target: string | null): void {
  const s = ctx.store();
  const byId = new Map(s.annotations.map((a) => [a.id, a]));
  const k = ctx.view.scale;
  if (op === "add") {
    const t = target ? byId.get(target) : undefined;
    const base = t ? regionOf(t.geometry) : null;
    if (t && base) {
      const g = geometryFromRegion(unionRegions(base, region, k));
      if (g) s.update(t.id, { geometry: keepPlacement(g, t.geometry) });
    } else {
      const g = geometryFromRegion(region);
      if (g) ctx.create(g);
    }
    return;
  }
  const bb: BBox = ringsBounds(region.map((p) => p[0]));
  const targets = target
    ? [byId.get(target)].filter((a): a is Annotation => !!a)
    : [...ctx.scene.alive()]
        .filter((e) => e.kind === "region" && isRegion(e.a.geometry) && e.a.label === s.activeLabel && ctx.editable(e.a) && bboxOverlap(e.bbox, bb))
        .map((e) => e.a);
  const remove: string[] = [];
  const update: { id: string; patch: { geometry: Geometry } }[] = [];
  for (const t of targets) {
    const base = regionOf(t.geometry);
    if (!base) continue;
    const cut = subtractRegion(base, region, k);
    if (regionArea(cut) === regionArea(base)) continue;
    const g = geometryFromRegion(cut);
    if (!g || regionArea(cut) < 1) remove.push(t.id);
    else update.push({ id: t.id, patch: { geometry: keepPlacement(g, t.geometry) } });
  }
  if (update.length || remove.length) s.batch({ update, remove });
}

/** A rebuilt region keeps the frame / slice / plane it was drawn on. */
function keepPlacement(g: Geometry, from: Geometry): Geometry {
  const src = from as { frame?: number; slice?: number; plane?: string };
  if (src.frame === undefined && src.slice === undefined && src.plane === undefined) return g;
  const out = { ...g } as Record<string, unknown>;
  for (const k of ["frame", "slice", "plane"] as const) if (src[k] !== undefined) out[k] = src[k];
  return out as Geometry;
}
