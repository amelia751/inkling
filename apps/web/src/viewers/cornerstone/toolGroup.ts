import type { Types } from "@cornerstonejs/core";
import type { AnyViewport } from "./viewControls";
import * as tools from "@cornerstonejs/tools";
import type { Tool, ToolOptions } from "@/stores/studio";
import { ANNOTATION_TOOLS, CS_TOOL } from "./bridge";
import { T } from "./init";

const { MouseBindings, ToolModes } = tools.Enums;
type ToolGroup = NonNullable<ReturnType<typeof tools.ToolGroupManager.getToolGroup>>;

export interface ToolGroupConfig {
  id: string;
  mode: "2d" | "3d";
  /** Inline text prompt for arrow annotations (resolves null when cancelled). */
  promptText: (initial?: string) => Promise<string | null>;
}

/** One tool group with every tool Inkling binds; navigation always on middle/right/wheel. */
export function createToolGroup({ id, mode, promptText }: ToolGroupConfig): ToolGroup {
  tools.ToolGroupManager.destroyToolGroup(id);
  const tg = tools.ToolGroupManager.createToolGroup(id)!;
  tg.addTool(tools.PanTool.toolName);
  tg.addTool(tools.ZoomTool.toolName, { minZoomScale: 0.05, maxZoomScale: 40 });
  tg.addTool(tools.WindowLevelTool.toolName);
  tg.addTool(tools.StackScrollTool.toolName);
  for (const name of ANNOTATION_TOOLS) {
    if (name === T.Keypoint || name === T.Polygon || name === tools.ArrowAnnotateTool.toolName) continue;
    tg.addTool(name);
  }
  tg.addToolInstance(T.Keypoint, tools.ProbeTool.toolName);
  tg.addToolInstance(T.Polygon, tools.SplineROITool.toolName, {
    spline: { type: "LINEAR", drawPreviewEnabled: true },
    calculateStats: true,
  });
  tg.addTool(tools.ArrowAnnotateTool.toolName, {
    getTextCallback: (done: (text: string) => void) => {
      promptText().then((t) => done(t ?? ""));
    },
    changeTextCallback: (data: { data?: { label?: string } }, _evt: unknown, done: (text: string) => void) => {
      promptText(data?.data?.label).then((t) => {
        if (t !== null) done(t);
      });
    },
  });
  const sphere = false;
  tg.addToolInstance(T.Brush, tools.BrushTool.toolName, { activeStrategy: sphere ? "FILL_INSIDE_SPHERE" : "FILL_INSIDE_CIRCLE" });
  tg.addToolInstance(T.Eraser, tools.BrushTool.toolName, { activeStrategy: sphere ? "ERASE_INSIDE_SPHERE" : "ERASE_INSIDE_CIRCLE" });
  if (mode === "3d") {
    tg.addTool(tools.CrosshairsTool.toolName, {
      getReferenceLineColor: (viewportId: string) =>
        viewportId.endsWith("axial") ? "rgb(239, 68, 68)" : viewportId.endsWith("sagittal") ? "rgb(234, 179, 8)" : "rgb(34, 197, 94)",
      getReferenceLineControllable: () => true,
      // Must be true or click-to-jump is disabled (CrosshairsTool._jump checks it).
      getReferenceLineDraggableRotatable: () => true,
      getReferenceLineSlabThicknessControlsOn: () => false,
    });
    tg.addTool(tools.ScaleOverlayTool.toolName);
  }
  // Navigation that works with any primary tool.
  tg.setToolActive(tools.PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
  tg.setToolActive(tools.ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
  if (mode === "3d") {
    // ScaleOverlayTool is enabled by the viewer once viewports are attached.
    tg.setToolActive(tools.StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
  } else {
    tg.setToolActive(tools.ZoomTool.toolName, {
      bindings: [{ mouseButton: MouseBindings.Secondary }, { mouseButton: MouseBindings.Wheel }],
    });
  }
  for (const name of ANNOTATION_TOOLS) tg.setToolPassive(name);
  return tg;
}

/** Bind the store's tool to the primary mouse button; annotation tools stay passive (editable). */
/**
 * `override` temporarily replaces the store tool with a Cornerstone tool name (Space-to-pan
 * binds Pan, the magnifier binds Magnify) without touching the store.
 */
export function bindPrimaryTool(tg: ToolGroup, tool: Tool, mode: "2d" | "3d", override?: string) {
  const primary = [{ mouseButton: MouseBindings.Primary }];
  const target = override ?? (tool === "select" || tool === "wand" ? undefined : CS_TOOL[tool]);
  const navigation = [tools.WindowLevelTool.toolName, T.Brush, T.Eraser];
  if (mode === "3d") navigation.push(tools.CrosshairsTool.toolName);
  // Pan / Zoom keep their middle/right/wheel bindings; only the primary binding moves.
  // (setToolActive merges bindings, so removing one needs setToolPassive, which drops the
  // primary binding and leaves the tool active on its other buttons.)
  for (const name of [tools.PanTool.toolName, tools.ZoomTool.toolName]) {
    const hasPrimary = (tg.getToolOptions(name)?.bindings ?? []).some((b: { mouseButton?: number }) => b.mouseButton === MouseBindings.Primary);
    if (name === target && !hasPrimary) tg.setToolActive(name, { bindings: primary });
    else if (name !== target && hasPrimary) tg.setToolPassive(name);
  }
  // Re-activating a tool that is already active would reset it (Crosshairs recenters).
  for (const name of navigation) {
    if (name !== target && tg.getToolOptions(name)?.mode === ToolModes.Active) tg.setToolDisabled(name);
  }
  for (const name of ANNOTATION_TOOLS) {
    if (name !== target && tg.getToolOptions(name)?.mode !== ToolModes.Passive) tg.setToolPassive(name);
  }
  if (!target || target === tools.PanTool.toolName || target === tools.ZoomTool.toolName) return;
  // Navigation tools are disabled when not in use, but keep their stored bindings.
  if (tg.getToolOptions(target)?.mode === ToolModes.Active) return;
  tg.setToolActive(target, { bindings: primary });
}

/** Brush radius in world units for a screen-pixel diameter at the viewport's current zoom. */
export function brushRadiusWorld(vp: AnyViewport, diameterPx: number): number {
  const viewport = vp as unknown as Types.IViewport;
  const cam = viewport.getCamera();
  const h = viewport.element.clientHeight || 1;
  const worldPerPx = ((cam.parallelScale ?? 1) * 2) / h;
  return Math.max(0.5, (diameterPx / 2) * worldPerPx);
}

/** Brush size, threshold strategy and sphere/circle choice. */
export function applyBrushOptions(
  tg: ToolGroup,
  viewport: AnyViewport | undefined,
  options: ToolOptions,
  voiRange: { lower: number; upper: number } | undefined,
  sphere: boolean,
) {
  if (viewport) {
    tools.utilities.segmentation.setBrushSizeForToolGroup(tg.id, brushRadiusWorld(viewport, options.brushSize));
  }
  const fill = options.brushThreshold ? (sphere ? "THRESHOLD_INSIDE_SPHERE" : "THRESHOLD_INSIDE_CIRCLE") : sphere ? "FILL_INSIDE_SPHERE" : "FILL_INSIDE_CIRCLE";
  tg.setToolConfiguration(T.Brush, {
    activeStrategy: fill,
    threshold: options.brushThreshold && voiRange ? { range: [voiRange.lower, voiRange.upper], isDynamic: false, dynamicRadius: 0 } : undefined,
  });
  tg.setToolConfiguration(T.Eraser, { activeStrategy: sphere ? "ERASE_INSIDE_SPHERE" : "ERASE_INSIDE_CIRCLE" });
}
