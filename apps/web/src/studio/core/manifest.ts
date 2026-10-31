import { tool } from "@studio/renderers/tool-catalog";
import { IS_MAC } from "@studio/ui/keys";
import { defineModule, type CommandContribution } from "@studio/plugin-ui-sdk/module";
import { coreGeometries, legacyGeometries } from "./geometries";
import { sourceLabelDisagreement, unlabeledItems } from "./reviewRules";
import { NAMING, ns } from "@studio/contracts/naming";

export const CORE = ns("core");
export const coreCommand = (name: string) => `${CORE}.commands.${name}`;

/** The Data page's commands (`section` is the route segment the shell sets). */
const FILES = "section == files";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * Studio-wide commands, plus shared viewer gestures gated on renderer capabilities so any
 * renderer that declares e.g. `drafting` or `playback` gets the same keys and sheet entries.
 */
const commands: CommandContribution[] = [
  { id: "undo", keys: ["mod+z"], label: "Undo", group: "Edit", description: "Undo the last change (an annotation in the Studio; a file operation in Data)" },
  { id: "redo", keys: ["shift+mod+z", "mod+y"], label: "Redo", group: "Edit", description: "Redo the last undone change" },
  { id: "deleteSelection", keys: ["Backspace", "Delete"], label: "Delete selected annotations", group: "Edit", description: "Delete the selected, unlocked annotations" },
  { id: "deselect", keys: ["Escape"], label: "Clear selection", group: "Edit", description: "Clear the selection" },
  { id: "selectAll", keys: ["mod+a"], label: "Select every annotation on this item", group: "Edit", description: "Select every visible annotation on the current item" },
  { id: "nextItem", keys: ["ArrowRight", "ArrowDown", "PageDown"], label: "Next item", group: "Navigate", repeat: true, description: "Go to the next item" },
  { id: "prevItem", keys: ["ArrowLeft", "ArrowUp", "PageUp"], label: "Previous item", group: "Navigate", repeat: true, description: "Go to the previous item" },
  { id: "nextTodo", keys: ["n"], label: "Next to do", group: "Navigate", description: "Go to the next item nobody has annotated yet, in queue order (the task's item order)" },
  { id: "pickLabel", keys: DIGITS, label: "Pick label by position", group: "Labels", display: "1 – 9", description: "Make the n-th label class active" },
  { id: "brushSmaller", keys: ["["], label: "Smaller brush", group: "Drawing", repeat: true, when: "'size' in tool.options", description: "Shrink the active tool's size" },
  { id: "brushLarger", keys: ["]"], label: "Larger brush", group: "Drawing", repeat: true, when: "'size' in tool.options", description: "Grow the active tool's size" },
  { id: "showShortcuts", keys: ["?"], label: "Keyboard shortcuts", group: "Help", description: "Open the keyboard shortcuts sheet" },
  // Shell (todo6 Phase 2, 4): also bound outside the Studio, where no environment is active.
  // `section` is the shell's page (`setShellContext`); environments always resolve with
  // `section == studio`, so the Data keys never claim Space or Enter in the Studio.
  { id: "toggleNavigation", keys: ["mod+b"], label: "Show or hide the project navigation", group: "Navigate", description: "Collapse the project sidebar to its icon rail, or expand it (in the Studio: hide or show the rail)" },
  // The project's drive (todo7 D11: the route, so the section, is `files`; the nav says "Data").
  { id: "quickLook", keys: ["space"], label: "Quick Look", group: "Data", when: FILES, description: "Preview the selected file large; arrows step through its folder" },
  { id: "openItem", keys: ["Enter"], label: "Open folder or details", group: "Data", when: FILES, description: "Open the selected folder, or show the selected file's details" },
  { id: "parentFolder", keys: ["mod+ArrowUp"], label: "Go to the enclosing folder", group: "Data", when: FILES, description: "Show the folder that contains the current one" },
  { id: "focusSearch", keys: ["mod+f"], label: "Search in data", group: "Data", when: FILES, description: "Search file names across the project's files" },
  // File operations (todo7 §2 Keyboard). Undo, redo and select all reuse the shared Edit
  // commands above (same keys); the Files page binds its own handlers to them.
  { id: "newFolder", keys: ["shift+mod+n"], label: "New folder", group: "Data", when: FILES, description: "Make a folder in the folder shown, and name it" },
  { id: "rename", keys: ["F2"], label: "Rename", group: "Data", when: FILES, description: "Rename the selected file or folder" },
  { id: "cut", keys: ["mod+x"], label: "Cut", group: "Data", when: FILES, description: "Mark the selection to be moved by Paste" },
  { id: "copy", keys: ["mod+c"], label: "Copy", group: "Data", when: FILES, description: "Mark the selection to be copied by Paste (copies share the same bytes)" },
  { id: "paste", keys: ["mod+v"], label: "Paste", group: "Data", when: FILES, description: "Move or copy what was cut or copied into the focused or shown folder" },
  { id: "duplicate", keys: ["mod+d"], label: "Duplicate", group: "Data", when: FILES, description: "Make a copy next to the original, named “name (copy)”" },
  { id: "moveToTrash", keys: IS_MAC ? ["mod+Backspace"] : ["Delete"], label: "Move to Trash", group: "Data", when: FILES, description: "Move the selection to Trash (undo brings it back)" },
  { id: "clearSelection", keys: ["Escape"], label: "Clear selection", group: "Data", when: FILES, description: "Deselect every file and folder" },
  { id: "expandAllBelow", keys: ["alt+ArrowRight"], label: "Expand all below", group: "Data", when: FILES, description: "Open the focused folder and every folder in it (up to 2,000 rows)" },
  { id: "toggleInspector", keys: ["mod+i"], label: "Show or hide details", group: "Data", when: FILES, description: "Show or hide the inspector (Info)" },
  { id: "filterItems", keys: ["mod+f"], label: "Filter items", group: "Navigate", when: "section == studio", description: "Filter the Items panel by name (while the panel has focus)" },
  { id: "contextMenu", keys: ["shift+F10", "ContextMenu"], label: "Open the context menu", group: "Data", when: FILES, description: "Open the menu of the focused file or folder, as a right-click does" },
  { id: "toggleSidePanel", keys: ["shift+mod+b"], label: "Show or hide items and labels", group: "Navigate", description: "Hide the Studio's left panel (Items and Labels) so the canvas takes its width, or show it again" },
  { id: "toggleAssistant", keys: ["mod+j"], label: `Show or hide ${NAMING.displayName} AI`, group: "Help", description: "Open or close the assistant, in any project section" },

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

/**
 * The shortcuts sheet's Essentials (todo8 D6): at most 8 rows, each naming core commands by
 * local name. A row shows when the environment binds at least one of its commands.
 */
export const ESSENTIALS: { label: string; commands: string[] }[] = [
  { label: "Undo / redo", commands: ["undo", "redo"] },
  { label: "Delete selected", commands: ["deleteSelection"] },
  { label: "Previous / next item", commands: ["prevItem", "nextItem"] },
  { label: "Next to do", commands: ["nextTodo"] },
  { label: "Pick label", commands: ["pickLabel"] },
  { label: "Hold Space to pan", commands: ["holdToPan"] },
  { label: "Keyboard shortcuts", commands: ["showShortcuts"] },
];

export default defineModule({
  id: CORE,
  version: "1.0.0",
  title: "Studio core",
  description: "Items, labels, all-annotations and AI panels; selection and navigation commands; select / pan / window-level tools; core geometries.",
  contributes: {
    geometries: [...coreGeometries, ...legacyGeometries],
    tools: [
      tool("select", { description: "Select, move and edit annotations" }),
      tool("pan", { description: "Pan and zoom the view" }),
      tool("windowLevel", { when: "'windowLevel' in renderer.capabilities", description: "Adjust contrast and brightness by dragging" }),
    ],
    commands,
    panels: [
      { id: "files", title: "Items", slot: "left", description: "The task's items, grouped, with per-item progress and a filter; the Studio titles the tab with the data kind's plural noun (Images, Studies, Slides)" },
      { id: "labels", title: "Labels", slot: "left", description: "Item-level classes, label classes (pick; hide, lock and color in each row's menu), the current item's annotations (\"On this item\") and the selection" },
      { id: "review", title: "All annotations", slot: "left", description: "Every annotation in the task with provenance, and the items with none yet; not in any preset (the project's Review page has the same feed), add it when a task needs it in the Studio" },
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
export { modArrows } from "@studio/ui/keys";
