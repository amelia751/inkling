import { brushTool } from "./brush";
import { lengthTool } from "./length";
import { pathTool } from "./path";
import { pointTool } from "./point";
import { selectTool } from "./select";
import { shapeTool } from "./shape";
import type { ToolMachine } from "./types";

export * from "./types";
export { applyRegion } from "./regionOps";
export { areaHits, hitAt, selectTool, type Hit } from "./select";
export { shapeGeometry, shapeTool } from "./shape";
export { pathTool } from "./path";
export { brushTool } from "./brush";
export { lengthTool } from "./length";
export { pointTool } from "./point";

/**
 * The overlay2d tool machines by tool name (the local names of `inkling.overlay2d.tools.*`
 * and the shared names modules reuse: `mark` is a keypoint for cell counting, `brush` /
 * `eraser` paint vector regions). `pan` has no machine: the host pans. A module adds its
 * own (the wsi wand) through OverlayEngine's `tools` option.
 */
export function defaultTools(): Record<string, ToolMachine> {
  return {
    select: selectTool(),
    box: shapeTool("box"),
    ellipse: shapeTool("ellipse"),
    polygon: pathTool("polygon"),
    polyline: pathTool("polyline"),
    freehand: pathTool("freehand"),
    keypoint: pointTool(),
    mark: pointTool(),
    length: lengthTool(),
    brush: brushTool(false),
    eraser: brushTool(true),
  };
}
