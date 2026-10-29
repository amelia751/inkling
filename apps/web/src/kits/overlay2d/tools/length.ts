import { r1, type Draft, type ToolMachine } from "./types";

type LengthDraft = Extract<Draft, { kind: "length" }>;

/** Drag a straight length measurement; stats and unit come from the context's `units`. */
export function lengthTool(): ToolMachine {
  let d: LengthDraft | null = null;
  return {
    needsLabel: true,
    cursor: "crosshair",
    down(e) {
      d = { kind: "length", a: e.p, b: e.p };
      return "claim";
    },
    move(e) {
      if (d) d.b = e.p;
    },
    up(_e, ctx) {
      if (!d) return;
      const { a, b } = d;
      d = null;
      const px = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (px * ctx.view.scale < 3) return;
      ctx.create(
        { type: "measurement", kind: "length", points: [a, b].map(([x, y]) => [r1(x), r1(y)]), space: "image", stats: ctx.units.lengthStats(px), unit: ctx.units.unit },
        false,
      );
    },
    cancel() {
      d = null;
    },
    draft: () => d,
  };
}
