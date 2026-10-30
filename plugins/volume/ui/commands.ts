import type { CommandContribution } from "@studio/plugin-ui-sdk/module";
import { VOLUME } from "./dataKind";
import { NS, ns } from "@studio/plugin-contracts/naming";

/**
 * The volume renderer's own commands (declared in the manifest, handled by the renderer
 * with `useCommands`). Pure data.
 */
export const volumeCommands: CommandContribution[] = [
  { id: "fitView", keys: ["="], label: "Fit to view", group: "View", description: "Reset every viewport (zoom, pan, flips, rotation, window)" },
  {
    id: "stepSlice",
    keys: ["ArrowUp", "ArrowDown"],
    display: "↑ ↓",
    label: "Previous or next slice",
    group: "Navigate",
    repeat: true,
    shadows: [ns("core.commands.prevItem"), ns("core.commands.nextItem")],
    description: "Scroll the active plane (↑ previous, ↓ next)",
  },
  { id: "firstLastSlice", keys: ["Home", "End"], display: "Home / End", label: "First or last slice", group: "Navigate", description: "Jump to the first (Home) or last (End) slice of the active plane" },
  {
    id: "cancelManipulation",
    keys: ["Escape"],
    label: "Cancel the drag in progress",
    group: "Drawing",
    contextual: true,
    description: "Cancel an in-progress Cornerstone drag (drawing, handle move); otherwise Escape falls through to clearing the selection",
  },
  { id: "interpolateSlices", label: "Interpolate mask slices", group: "Drawing", description: "Fill the slices between painted slices of the active label along the active plane (shape-based interpolation)" },
  { id: "removeIslands", label: "Remove mask islands", group: "Drawing", description: "Keep only the largest 3D connected region of the active label" },
  { id: "smartFill", label: "Wand: smart fill", group: "Drawing", when: "tool == wand", description: "Wand clicks grow a 3D region from the clicked structure's intensity statistics (confidence-connected, ±40 mm)" },
  { id: "similarFill", label: "Wand: similar intensity", group: "Drawing", when: "tool == wand", description: "Wand clicks flood the connected region on the clicked slice within ±8% of the window" },
];

const cs = (name: string) => `${NS}.cornerstone.commands.${name}`;
const own = (name: string) => `${VOLUME}.commands.${name}`;

/** Full ids of every command the renderer handles (its own, Cornerstone's and core's). */
export const VOLUME_COMMANDS = {
  fitView: own("fitView"),
  stepSlice: own("stepSlice"),
  firstLastSlice: own("firstLastSlice"),
  cancel: own("cancelManipulation"),
  interpolate: own("interpolateSlices"),
  removeIslands: own("removeIslands"),
  smartFill: own("smartFill"),
  similarFill: own("similarFill"),
  invert: cs("invertImage"),
  flipH: cs("flipHorizontal"),
  flipV: cs("flipVertical"),
  rotateLeft: cs("rotateViewLeft"),
  magnifier: cs("toggleMagnifier"),
  rotateRight: ns("core.commands.rotateView"),
  holdToPan: ns("core.commands.holdToPan"),
} as const;
