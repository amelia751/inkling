import { tool } from "@studio/studio-renderers/tool-catalog";
import { IS_MAC } from "@studio/studio-ui/keys";
import { defineModule, type CommandContribution } from "@studio/plugin-ui-sdk/module";
import { coreGeometries, legacyGeometries } from "./geometries";
import { sourceLabelDisagreement, unlabeledItems } from "./reviewRules";
import { NAMING, ns } from "@studio/plugin-contracts/naming";

export const CORE = ns("core");
export const coreCommand = (name: string) => `${CORE}.commands.${name}`;

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * Studio-wide commands, plus shared viewer gestures gated on renderer capabilities so any
 * renderer that declares e.g. `drafting` or `playback` gets the same keys and sheet entries.
 */
const commands: CommandContribution[] = [
  { id: "undo", keys: ["mod+z"], label: "Undo", group: "Edit", description: "Undo the last annotation change" },
  { id: "redo", keys: ["shift+mod+z", "mod+y"], label: "Redo", group: "Edit", description: "Redo" },
  { id: "deleteSelection", keys: ["Backspace", "Delete"], label: "Delete selected annotations", group: "Edit", description: "Delete the selected, unlocked annotations" },
  { id: "deselect", keys: ["Escape"], label: "Clear selection", group: "Edit", description: "Clear the selection" },
  { id: "selectAll", keys: ["mod+a"], label: "Select every annotation on this item", group: "Edit", description: "Select every visible annotation on the current item" },
  { id: "nextItem", keys: ["ArrowRight", "ArrowDown", "PageDown"], label: "Next item", group: "Navigate", repeat: true, description: "Go to the next item" },
  { id: "prevItem", keys: ["ArrowLeft", "ArrowUp", "PageUp"], label: "Previous item", group: "Navigate", repeat: true, description: "Go to the previous item" },
  { id: "pickLabel", keys: DIGITS, label: "Pick label by position", group: "Labels", display: "1 – 9", description: "Make the n-th label class active" },
  { id: "brushSmaller", keys: ["["], label: "Smaller brush", group: "Drawing", repeat: true, when: "'size' in tool.options", description: "Shrink the active tool's size" },
  { id: "brushLarger", keys: ["]"], label: "Larger brush", group: "Drawing", repeat: true, when: "'size' in tool.options", description: "Grow the active tool's size" },
  { id: "showShortcuts", keys: ["?"], label: "Keyboard shortcuts", group: "Help", description: "Open the keyboard shortcuts sheet" },

  // Shared renderer gestures.
  { id: "finishShape", keys: ["Enter"], label: "Close the polygon", group: "Drawing", contextual: true, when: "'drafting' in renderer.capabilities", description: "Close the shape being drawn" },
  { id: "cancelShape", keys: ["Escape"], label: "Cancel the shape in progress", group: "Drawing", contextual: true, when: "'drafting' in renderer.capabilities", description: "Cancel the shape being drawn" },
  { id: "removeLastVertex", keys: ["Backspace"], label: "Remove the last vertex", group: "Drawing", contextual: true, when: "'vertexUndo' in renderer.capabilities", description: "Remove the last vertex of the shape being drawn" },
  { id: "holdToPan", keys: ["space"], label: "Hold and drag to pan", group: "View", contextual: true, when: "'holdToPan' in renderer.capabilities", description: "Pan while Space is held, whatever the tool" },
  { id: "rotateView", keys: ["shift+r"], label: "Rotate 90°", group: "View", when: "'rotate' in renderer.capabilities", description: "Rotate the view 90° clockwise" },
  { id: "playPause", keys: ["space"], label: "Play or pause", group: "Playback", when: "'playback' in renderer.capabilities", description: "Play or pause" },
  { id: "prevFrame", keys: [","], label: "Previous frame", group: "Playback", repeat: true, when: "'playback' in renderer.capabilities", description: "Step one frame back" },
  { id: "nextFrame", keys: ["."], label: "Next frame", group: "Playback", repeat: true, when: "'playback' in renderer.capabilities", description: "Step one frame forward" },

  // Reviewing AI suggestions, for renderers that list them in order.
  { id: "nextSuggestion", keys: ["Tab"], label: "Next AI suggestion", group: "Edit", contextual: true, when: "'suggestions' in renderer.capabilities", description: "Select the next unreviewed AI suggestion" },
  { id: "prevSuggestion", keys: ["shift+Tab"], label: "Previous AI suggestion", group: "Edit", contextual: true, when: "'suggestions' in renderer.capabilities", description: "Select the previous unreviewed AI suggestion" },
  { id: "acceptSuggestion", keys: ["Enter"], label: "Accept selected AI suggestions", group: "Edit", contextual: true, when: "'suggestions' in renderer.capabilities", description: "Mark the selected AI suggestions as reviewed" },
  { id: "rejectSuggestion", keys: ["Delete", "Backspace"], label: "Reject the AI suggestion and go to the next", group: "Edit", contextual: true, when: "'suggestions' in renderer.capabilities", description: "Delete the selected AI suggestion and select the next" },
];

export default defineModule({
  id: CORE,
  version: "1.0.0",
  title: "Studio core",
  description: "Files, labels, review and AI panels; selection and navigation commands; select / pan / window-level tools; core geometries.",
  contributes: {
    geometries: [...coreGeometries, ...legacyGeometries],
    tools: [
      tool("select", { description: "Select, move and edit annotations" }),
      tool("pan", { description: "Pan and zoom the view" }),
      tool("windowLevel", { when: "'windowLevel' in renderer.capabilities", description: "Adjust contrast and brightness by dragging" }),
    ],
    commands,
    panels: [
      { id: "files", title: "Files", slot: "left", description: "The project's items, grouped, with per-item progress and a filter" },
      { id: "labels", title: "Labels", slot: "left", description: "Label classes (pick, hide, lock), item-level classes, overlay opacity and the selection inspector" },
      { id: "review", title: "Review", slot: "left", description: "Every annotation with provenance, and the items with none yet" },
      { id: "ai", title: `${NAMING.displayName} AI`, slot: "right", description: "Assistant that can read and edit this environment (agent tools)" },
    ],
    labelControls: [
      { id: "Labels", geometries: ["box", "ellipse", "polygon", "multipolygon", "polyline", "spline", "keypoint", "point3d", "measurement", "mask", "span", "instant", "track"], description: "Classes for any drawn geometry" },
      { id: "RectangleLabels", geometries: ["box"], description: "Classes for boxes" },
      { id: "EllipseLabels", geometries: ["ellipse"], description: "Classes for ellipses" },
      { id: "PolygonLabels", geometries: ["polygon", "multipolygon", "spline"], description: "Classes for polygons and regions" },
      { id: "KeyPointLabels", geometries: ["keypoint", "point3d"], description: "Classes for points" },
      { id: "BrushLabels", geometries: ["mask"], description: "Classes for painted masks" },
      { id: "TimeSeriesLabels", geometries: ["span", "instant"], description: "Classes for spans and instants on a time axis" },
      { id: "VideoRectangle", geometries: ["track", "box"], description: "Classes for objects tracked through video" },
      { id: "Choices", geometries: [], itemLevel: true, description: "Item-level classes; `multiple: true` allows several per item" },
    ],
    reviewRules: [sourceLabelDisagreement, unlabeledItems],
  },
  load: () => import("./impl"),
});

/** Keys shown for the copy-contour style families ("⌥ + arrows"). */
export { modArrows } from "@studio/studio-ui/keys";
