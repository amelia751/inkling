import { polygonArea, simplify } from "../geometry";
import { CLOSE_RADIUS } from "../draw";
import { dist, r1pts, type Draft, type ToolContext, type ToolMachine } from "./types";

type PathDraft = Extract<Draft, { kind: "path" }>;
export type PathToolName = PathDraft["tool"];

/**
 * Polygon / polyline: click to place vertices (dragging while pressed adds more), close
 * on the first vertex (polygon), double-click or Enter; Backspace drops the last vertex.
 * Freehand: one drag traces a closed outline, simplified to ~¾ screen px.
 */
export function pathTool(tool: PathToolName): ToolMachine {
  let d: PathDraft | null = null;

  const finish = (ctx: ToolContext): boolean => {
    if (!d) return false;
    const pts0 = d.points;
    d = null;
    // Drop near-duplicate trailing points (double-click leaves one).
    const tol = 0.75 / ctx.view.scale;
    let pts = pts0.filter((p, i) => i === 0 || dist(p, pts0[i - 1]) > tol);
    if (tool === "freehand") pts = simplify(pts, tol);
    if (tool === "polyline") {
      if (pts.length >= 2) ctx.create({ type: "polyline", points: r1pts(pts) });
    } else if (pts.length >= 3 && polygonArea(pts) * ctx.view.scale ** 2 > 4) {
      ctx.create({ type: "polygon", points: r1pts(pts) });
    }
    return true;
  };

  return {
    needsLabel: true,
    cursor: "crosshair",
    down(e, ctx) {
      if (tool === "freehand" || !d) {
        d = { kind: "path", tool, points: [e.p], pressing: true, lastScreen: e.screen };
        return "claim";
      }
      if (e.dbl) {
        finish(ctx);
        return "consume";
      }
      if (tool === "polygon" && d.points.length >= 3 && dist(ctx.view.toScreen(...d.points[0]), e.screen) <= CLOSE_RADIUS) {
        finish(ctx);
        return "consume";
      }
      d.points.push(e.p);
      d.pressing = true;
      d.lastScreen = e.screen;
      return "claim";
    },
    move(e) {
      if (d?.pressing && dist(e.screen, d.lastScreen) > 3) {
        d.points.push(e.p);
        d.lastScreen = e.screen;
      }
    },
    up(_e, ctx) {
      if (!d) return;
      d.pressing = false;
      if (tool === "freehand") finish(ctx);
    },
    // A lost pointer keeps the vertices placed so far.
    lost() {
      if (d) d.pressing = false;
    },
    cancel() {
      d = null;
    },
    finish,
    removeLast() {
      if (!d) return false;
      d.points.pop();
      if (!d.points.length) d = null;
      return true;
    },
    draft: () => d,
    hint() {
      if (!d || tool === "freehand") return null;
      return tool === "polygon"
        ? `${d.points.length} points · click the first point, double-click or Enter to close · Backspace removes a point · Esc cancels`
        : `${d.points.length} points · double-click or Enter to finish · Backspace removes a point · Esc cancels`;
    },
  };
}
