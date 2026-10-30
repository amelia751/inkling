import { r1, type ToolMachine } from "./types";

/** Click to place a keypoint (cell counting, landmarks). Doesn't select it, so clicking on keeps counting. */
export function pointTool(): ToolMachine {
  return {
    needsLabel: true,
    cursor: "crosshair",
    down(e, ctx) {
      ctx.create({ type: "keypoint", x: r1(e.p[0]), y: r1(e.p[1]) }, false);
      return "consume";
    },
    cancel() {},
    draft: () => null,
  };
}
