import type { Annotation } from "@studio/contracts/types";
import { registerDiffPreview, type DiffPreviewProps } from "@/extension-host/trusted-renderers";

/**
 * The built-in diff preview for 2-D shapes (boxes and polygons): before dashed, after solid,
 * on a shared frame. Type-specific previews (mask overlays, spans on a timeline) come from
 * the modules that own those geometries through the same registry.
 */
type Pt = [number, number];

function shapePoints(a?: Annotation): Pt[] {
  const g = a?.geometry as { type?: string; x?: number; y?: number; w?: number; h?: number; points?: Pt[] } | undefined;
  if (!g) return [];
  if (g.type === "box" && g.x !== undefined && g.y !== undefined && g.w !== undefined && g.h !== undefined)
    return [[g.x, g.y], [g.x + g.w, g.y], [g.x + g.w, g.y + g.h], [g.x, g.y + g.h]];
  if (g.type === "polygon" && Array.isArray(g.points)) return g.points;
  return [];
}

export function ShapeDiffPreview({ base, head }: DiffPreviewProps) {
  const before = shapePoints(base);
  const after = shapePoints(head);
  const all = [...before, ...after];
  if (!all.length) return null;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const pad = Math.max(2, (Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys)) * 0.08);
  const vb = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad || 1, Math.max(...ys) - Math.min(...ys) + 2 * pad || 1];
  const path = (pts: Pt[]) => pts.map((p) => p.join(",")).join(" ");
  return (
    <svg viewBox={vb.join(" ")} className="h-16 w-24 shrink-0 rounded-sm bg-generic" aria-label="Shape before and after" data-testid="diff-preview-shape">
      {before.length > 0 && <polygon points={path(before)} fill="none" stroke="currentColor" className="text-muted-foreground" strokeDasharray="2 2" strokeWidth={vb[2] / 60} vectorEffect="non-scaling-stroke" />}
      {after.length > 0 && <polygon points={path(after)} fill="none" stroke="currentColor" className="text-brand" strokeWidth={vb[2] / 40} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

let registered = false;
export function registerBuiltinPreviews(): void {
  if (registered) return;
  registered = true;
  registerDiffPreview("studio.diff-shape.v1", { geometries: ["box", "polygon"], component: ShapeDiffPreview, description: "Boxes and polygons before (dashed) and after (solid)" });
}
