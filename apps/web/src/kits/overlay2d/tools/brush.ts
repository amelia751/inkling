import { brushSizeOf } from "@/stores/studio";
import type { Pt } from "@/types";
import { pointInRegion, strokeToRegion } from "../regions";
import { dist, type Draft, type ToolMachine } from "./types";

type BrushDraft = Extract<Draft, { kind: "brush" }>;

/**
 * Brush / eraser on vector regions (QuPath style). A stroke that starts inside the selected
 * region of the active label (or any stroke with Shift) grows it; otherwise it makes a new
 * region. The eraser (or Alt + brush) cuts from the selection, or from every editable
 * region of the active label it crosses. Size is the tool's `size` option in screen px.
 */
export function brushTool(eraser: boolean): ToolMachine {
  let d: BrushDraft | null = null;
  return {
    needsLabel: true,
    cursor: "none",
    down(e, ctx) {
      const s = ctx.store();
      const erase = eraser || e.alt;
      const radius = brushSizeOf(s) / 2 / ctx.view.scale;
      const sel = ctx.selected();
      let addTo: string | null = null;
      if (sel && sel.kind === "region" && ctx.editable(sel.a) && (erase || sel.a.label === s.activeLabel) && (e.shift || erase || pointInRegion(e.p, sel.region!))) addTo = sel.a.id;
      d = { kind: "brush", erase, points: [e.p], radius, addTo, lastScreen: e.screen };
      return "claim";
    },
    move(e) {
      if (d && dist(e.screen, d.lastScreen) > 1.5) {
        d.points.push(e.p as Pt);
        d.lastScreen = e.screen;
      }
    },
    up(_e, ctx) {
      if (!d) return;
      const { points, radius, erase, addTo } = d;
      d = null;
      const stroke = strokeToRegion(points, radius, ctx.view.scale);
      if (stroke.length) ctx.applyRegion(stroke, erase ? "subtract" : "add", addTo);
    },
    cancel() {
      d = null;
    },
    draft: () => d,
    ring: (ctx) => ({ radius: brushSizeOf(ctx.store()) / 2, erase: eraser }),
  };
}
