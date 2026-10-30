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
  RhythmIcon,
  SegmentIcon,
  SelectIcon,
  SplineIcon,
  WaveIcon,
  WindowLevelIcon,
  ZoomInIcon,
  type IconComponent,
} from "@studio/ui/icons";
import type { ToolContribution, ToolGroup } from "@studio/plugin-ui-sdk/module";

/**
 * Shared presentation for tool names (label, hint, icon, group, default hotkey). Modules
 * build their tool contributions from it with `tool(name, …)`, so "Box" looks and binds the
 * same whichever renderer implements it. Hotkeys follow OHIF / QuPath / CVAT conventions
 * where those agree; they only need to be unique within one environment.
 */
const META: Record<string, { label: string; hint: string; icon: IconComponent; group: ToolGroup; hotkey: string }> = {
  select: { label: "Select", hint: "Select, move and edit annotations. Drag a handle to reshape; Delete removes", icon: SelectIcon, group: "navigate", hotkey: "v" },
  pan: { label: "Pan", hint: "Drag to move the image; scroll to zoom. Hold Space with any tool to pan", icon: PanIcon, group: "navigate", hotkey: "h" },
  zoom: { label: "Zoom", hint: "Drag up/down to zoom", icon: ZoomInIcon, group: "navigate", hotkey: "z" },
  windowLevel: { label: "Window/level", hint: "Drag horizontally for contrast (window), vertically for brightness (level)", icon: WindowLevelIcon, group: "navigate", hotkey: "w" },
  crosshairs: { label: "Crosshairs", hint: "Click or drag to move the linked crosshair through all three planes", icon: CrosshairsIcon, group: "navigate", hotkey: "c" },
  box: { label: "Box", hint: "Drag to outline a rectangular region with the active label", icon: BoxIcon, group: "shape", hotkey: "r" },
  ellipse: { label: "Ellipse", hint: "Drag to draw an ellipse; reports area and intensity stats", icon: EllipseIcon, group: "shape", hotkey: "o" },
  polygon: { label: "Polygon", hint: "Click to place vertices; click the first point, double-click or press Enter to close. Esc cancels", icon: PolygonIcon, group: "shape", hotkey: "p" },
  freehand: { label: "Freehand", hint: "Drag to trace a closed outline", icon: FreehandIcon, group: "shape", hotkey: "f" },
  polyline: { label: "Polyline", hint: "Click to place points along an open line; double-click or Enter to finish", icon: PolylineIcon, group: "shape", hotkey: "y" },
  spline: { label: "Spline contour", hint: "Click control points for a smooth closed contour; drag points to adjust, click an edge to add one, Alt-click to delete", icon: SplineIcon, group: "shape", hotkey: "s" },
  keypoint: { label: "Keypoint", hint: "Click to place a landmark", icon: KeypointIcon, group: "shape", hotkey: "k" },
  point: { label: "Point", hint: "Click to mark a 3D location with the active label", icon: Point3DIcon, group: "shape", hotkey: "k" },
  mark: { label: "Points", hint: "Click to mark a single location, e.g. a cell; counts per class appear in the panel", icon: PointMarksIcon, group: "shape", hotkey: "." },
  length: { label: "Length", hint: "Drag to measure a distance", icon: LengthIcon, group: "measure", hotkey: "l" },
  angle: { label: "Angle", hint: "Click three points to measure an angle", icon: AngleIcon, group: "measure", hotkey: "a" },
  cobb: { label: "Cobb angle", hint: "Draw two lines along vertebral endplates to measure the angle between them", icon: CobbAngleIcon, group: "measure", hotkey: "j" },
  bidirectional: { label: "Bidirectional", hint: "Draw the long axis; the perpendicular short axis follows (RECIST)", icon: BidirectionalIcon, group: "measure", hotkey: "d" },
  probe: { label: "Probe", hint: "Click to read the pixel value (HU for CT) at a point", icon: ProbeIcon, group: "measure", hotkey: "i" },
  arrow: { label: "Arrow", hint: "Drag to point an arrow at a finding and add a note", icon: ArrowNoteIcon, group: "measure", hotkey: "x" },
  brush: { label: "Brush", hint: "Paint a mask with the active label. [ and ] change the size", icon: BrushIcon, group: "mask", hotkey: "b" },
  eraser: { label: "Eraser", hint: "Erase mask or region area. [ and ] change the size", icon: EraserIcon, group: "mask", hotkey: "e" },
  wand: { label: "Fill", hint: "Click to flood-fill a connected region of similar intensity", icon: FillIcon, group: "mask", hotkey: "g" },
  interval: { label: "Interval", hint: "Drag across a lead to mark a time span; Shift-drag marks all leads", icon: IntervalIcon, group: "time", hotkey: "i" },
  beat: { label: "Beat", hint: "Click a beat to place a fiducial; type a WFDB code (N, V, A…) to change it", icon: BeatIcon, group: "time", hotkey: "b" },
  wave: { label: "Wave", hint: "Drag from a wave's onset to its offset to delineate P, QRS or T", icon: WaveIcon, group: "time", hotkey: "q" },
  rhythm: { label: "Rhythm", hint: "Drag on the rhythm track to label an episode", icon: RhythmIcon, group: "time", hotkey: "y" },
  caliper: { label: "Caliper", hint: "Drag to measure Δt, heart rate and ΔmV. Not saved", icon: CaliperIcon, group: "time", hotkey: "c" },
  segment: { label: "Segment", hint: "Drag along the timeline to label a span of the video", icon: SegmentIcon, group: "time", hotkey: "s" },
  event: { label: "Event", hint: "Mark the current frame as a point-in-time event", icon: EventIcon, group: "time", hotkey: "t" },
};

type ToolExtra = Partial<Omit<ToolContribution, "id">> & Pick<ToolContribution, "description">;

/** A tool contribution named `name`, with shared presentation and module-specific behavior. */
export function tool(name: string, extra: ToolExtra): ToolContribution {
  const m = META[name];
  if (!m && !(extra.label && extra.icon && extra.group)) throw new Error(`Unknown tool "${name}": give label, icon and group`);
  return { id: name, ...m, ...extra } as ToolContribution;
}
