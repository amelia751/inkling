import { Fragment } from "react";
import {
  AngleIcon,
  ArrowNoteIcon,
  BeatIcon,
  BidirectionalIcon,
  BoxIcon,
  BrushIcon,
  CaliperIcon,
  CobbAngleIcon,
  CrosshairsIcon,
  EllipseIcon,
  EraserIcon,
  EventIcon,
  FillIcon,
  FreehandIcon,
  IntervalIcon,
  KeypointIcon,
  LengthIcon,
  PanIcon,
  Point3DIcon,
  PointMarksIcon,
  PolygonIcon,
  PolylineIcon,
  ProbeIcon,
  RedoIcon,
  RhythmIcon,
  SegmentIcon,
  SelectIcon,
  SplineIcon,
  UndoIcon,
  WaveIcon,
  WindowLevelIcon,
  ZoomInIcon,
  type IconComponent,
} from "@/components/icons";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { ActionTooltipContent, Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { TOOL_KEYS, type ShortcutId } from "@/lib/shortcuts";
import { labelColor } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useStudio, type Tool } from "@/stores/studio";
import type { Project } from "@/types";

type Group = "navigate" | "shape" | "measure" | "mask" | "time";

/** Every tool's name, hint, icon and toolbar group. Shortcut keys live in `TOOL_KEYS` (lib/shortcuts). */
export const TOOL_META: Record<Tool, { label: string; hint: string; icon: IconComponent; group: Group }> = {
  select: { label: "Select", hint: "Select, move and edit annotations. Drag a handle to reshape; Delete removes", icon: SelectIcon, group: "navigate" },
  pan: { label: "Pan", hint: "Drag to move the image; scroll to zoom. Hold Space with any tool to pan", icon: PanIcon, group: "navigate" },
  zoom: { label: "Zoom", hint: "Drag up/down to zoom", icon: ZoomInIcon, group: "navigate" },
  windowLevel: { label: "Window/level", hint: "Drag horizontally for contrast (window), vertically for brightness (level)", icon: WindowLevelIcon, group: "navigate" },
  crosshairs: { label: "Crosshairs", hint: "Click or drag to move the linked crosshair through all three planes", icon: CrosshairsIcon, group: "navigate" },
  box: { label: "Box", hint: "Drag to outline a rectangular region with the active label", icon: BoxIcon, group: "shape" },
  ellipse: { label: "Ellipse", hint: "Drag to draw an ellipse; reports area and intensity stats", icon: EllipseIcon, group: "shape" },
  polygon: { label: "Polygon", hint: "Click to place vertices; click the first point, double-click or press Enter to close. Esc cancels", icon: PolygonIcon, group: "shape" },
  freehand: { label: "Freehand", hint: "Drag to trace a closed outline", icon: FreehandIcon, group: "shape" },
  polyline: { label: "Polyline", hint: "Click to place points along an open line; double-click or Enter to finish", icon: PolylineIcon, group: "shape" },
  spline: { label: "Spline contour", hint: "Click control points for a smooth closed contour; drag points to adjust, click an edge to add one, Alt-click to delete", icon: SplineIcon, group: "shape" },
  keypoint: { label: "Keypoint", hint: "Click to place a landmark", icon: KeypointIcon, group: "shape" },
  point: { label: "Point", hint: "Click to mark a 3D location with the active label", icon: Point3DIcon, group: "shape" },
  mark: { label: "Points", hint: "Click to mark a single location, e.g. a cell; counts per class appear in the panel", icon: PointMarksIcon, group: "shape" },
  length: { label: "Length", hint: "Drag to measure a distance", icon: LengthIcon, group: "measure" },
  angle: { label: "Angle", hint: "Click three points to measure an angle", icon: AngleIcon, group: "measure" },
  cobb: { label: "Cobb angle", hint: "Draw two lines along vertebral endplates to measure the angle between them", icon: CobbAngleIcon, group: "measure" },
  bidirectional: { label: "Bidirectional", hint: "Draw the long axis; the perpendicular short axis follows (RECIST)", icon: BidirectionalIcon, group: "measure" },
  probe: { label: "Probe", hint: "Click to read the pixel value (HU for CT) at a point", icon: ProbeIcon, group: "measure" },
  arrow: { label: "Arrow", hint: "Drag to point an arrow at a finding and add a note", icon: ArrowNoteIcon, group: "measure" },
  brush: { label: "Brush", hint: "Paint a mask with the active label. [ and ] change the size", icon: BrushIcon, group: "mask" },
  eraser: { label: "Eraser", hint: "Erase mask or region area. [ and ] change the size", icon: EraserIcon, group: "mask" },
  wand: { label: "Fill", hint: "Click to flood-fill a connected region of similar intensity", icon: FillIcon, group: "mask" },
  interval: { label: "Interval", hint: "Drag across a lead to mark a time span; Shift-drag marks all leads", icon: IntervalIcon, group: "time" },
  beat: { label: "Beat", hint: "Click a beat to place a fiducial; type a WFDB code (N, V, A…) to change it", icon: BeatIcon, group: "time" },
  wave: { label: "Wave", hint: "Drag from a wave's onset to its offset to delineate P, QRS or T", icon: WaveIcon, group: "time" },
  rhythm: { label: "Rhythm", hint: "Drag on the rhythm track to label an episode", icon: RhythmIcon, group: "time" },
  caliper: { label: "Caliper", hint: "Drag to measure Δt, heart rate and ΔmV. Not saved", icon: CaliperIcon, group: "time" },
  segment: { label: "Segment", hint: "Drag along the timeline to label a span of the video", icon: SegmentIcon, group: "time" },
  event: { label: "Event", hint: "Mark the current frame as a point-in-time event", icon: EventIcon, group: "time" },
};

const COMPACT_AFTER = 7;
const SIZED_TOOLS: Tool[] = ["brush", "eraser"];

export function CanvasToolbar({ project, tools }: { project: Project; tools: Tool[] }) {
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const options = useStudio((s) => s.toolOptions);
  const setOptions = useStudio((s) => s.setToolOptions);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const labels = project.labels ?? [];
  const drawing = TOOL_META[tool].group !== "navigate" && tool !== "probe" && tool !== "caliper";
  const compact = tools.length > COMPACT_AFTER;

  return (
    <div className="@container hide-scrollbar flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2" role="toolbar" aria-label="Annotation tools">
      {tools.map((t, i) => {
        const meta = TOOL_META[t];
        const newGroup = i > 0 && TOOL_META[tools[i - 1]].group !== meta.group;
        return (
          <Fragment key={t}>
            {newGroup && <Separator orientation="vertical" className="mx-0.5 h-5" />}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost-secondary"
                  selected={tool === t}
                  onClick={() => setTool(t)}
                  className={cn("shrink-0", compact ? "w-7 px-0" : "px-2 @max-[720px]:w-7 @max-[720px]:px-0")}
                  aria-pressed={tool === t}
                  aria-label={meta.label}
                  data-tool={t}
                >
                  <meta.icon />
                  {!compact && <span className="hidden @[720px]:inline">{meta.label}</span>}
                </Button>
              </TooltipTrigger>
              <ActionTooltipContent title={meta.label} shortcut={TOOL_KEYS[t]} description={meta.hint} />
            </Tooltip>
          </Fragment>
        );
      })}
      <Separator orientation="vertical" className="mx-1 h-5" />
      <IconAction icon={UndoIcon} label="Undo" shortcut="undo" onClick={undo} disabled={!canUndo} />
      <IconAction icon={RedoIcon} label="Redo" shortcut="redo" onClick={redo} disabled={!canRedo} />

      {SIZED_TOOLS.includes(tool) && (
        <div className="ml-2 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span>Size</span>
          <Slider
            value={[options.brushSize]}
            min={2}
            max={120}
            step={1}
            onValueChange={([v]) => setOptions({ brushSize: v })}
            className="w-24"
            aria-label="Brush size"
          />
          <span className="tnum w-9">{options.brushSize}px</span>
          {/* Intensity thresholds only make sense on grayscale radiology/cine images. */}
          {tool === "brush" && project.viewer !== "pathology" && (
            <label className="flex items-center gap-1" title="Only paint pixels whose intensity is inside the current window">
              <input type="checkbox" checked={options.brushThreshold} onChange={(e) => setOptions({ brushThreshold: e.target.checked })} />
              Threshold
            </label>
          )}
        </div>
      )}

      {drawing && activeLabel && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-muted-foreground">
          Drawing
          <span className="flex items-center gap-1 rounded-md bg-generic px-2 py-0.5 capitalize text-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: labelColor(labels, activeLabel) }} />
            {activeLabel}
          </span>
        </div>
      )}
    </div>
  );
}

function IconAction({ icon: Icon, label, shortcut, onClick, disabled }: { icon: IconComponent; label: string; shortcut: ShortcutId; onClick: () => void; disabled: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The span keeps the tooltip working while the button is disabled. */}
        <span className="inline-flex shrink-0">
          <Button variant="ghost-secondary" size="icon" onClick={onClick} disabled={disabled} aria-label={label}>
            <Icon />
          </Button>
        </span>
      </TooltipTrigger>
      <ActionTooltipContent title={label} shortcut={shortcut} />
    </Tooltip>
  );
}
