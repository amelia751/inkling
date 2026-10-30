import type { Geometry } from "@studio/contracts/types";
import { r1, type Draft, type ToolMachine } from "./types";

type ShapeDraft = Extract<Draft, { kind: "shape" }>;

/** Geometry of a box / ellipse drag; Shift makes it a square / circle. */
export function shapeGeometry(d: ShapeDraft): Extract<Geometry, { type: "box" | "ellipse" }> {
  let [bx, by] = d.b;
  const [ax, ay] = d.a;
  if (d.square) {
    const side = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    bx = ax + Math.sign(bx - ax || 1) * side;
    by = ay + Math.sign(by - ay || 1) * side;
  }
  const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
  return d.tool === "box" ? { type: "box", x, y, w, h } : { type: "ellipse", cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
}

/** Drag out a box or ellipse. Shapes under 4 screen px are dropped as misclicks. */
export function shapeTool(tool: "box" | "ellipse"): ToolMachine {
  let d: ShapeDraft | null = null;
  return {
    needsLabel: true,
    cursor: "crosshair",
    down(e) {
      d = { kind: "shape", tool, a: e.p, b: e.p, square: e.shift };
      return "claim";
    },
    move(e) {
      if (!d) return;
      d.b = e.p;
      d.square = e.shift;
    },
    up(_e, ctx) {
      if (!d) return;
      const g = shapeGeometry(d);
      d = null;
      const s = ctx.view.scale;
      if (g.type === "box") {
        if (Math.max(g.w, g.h) * s >= 4) ctx.create({ type: "box", x: r1(g.x), y: r1(g.y), w: r1(g.w), h: r1(g.h) });
      } else if (Math.max(g.rx, g.ry) * 2 * s >= 4) {
        ctx.create({ type: "ellipse", cx: r1(g.cx), cy: r1(g.cy), rx: r1(g.rx), ry: r1(g.ry) });
      }
    },
    cancel() {
      d = null;
    },
    draft: () => d,
  };
}
