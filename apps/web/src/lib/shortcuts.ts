import type { Tool } from "@/stores/studio";
import type { ViewerKind } from "@/types";

/**
 * The single list of keyboard shortcuts. Handlers bind to these ids through
 * `useShortcuts`, and tooltips and the "?" sheet read labels and keys from here,
 * so a key only ever changes in one place.
 *
 * Key syntax: modifiers `mod` (⌘ on macOS, Ctrl elsewhere), `alt`, `shift`, joined
 * with `+`. Letters match the character typed (so Dvorak and AZERTY users press
 * the letter they see); digits and `[ ] , . space` match the physical key, so they
 * work on layouts where those characters need Shift.
 */
export interface ShortcutDef {
  /** The first combo is the one shown in the UI. */
  keys: string[];
  label: string;
  group: ShortcutGroup;
  /** Fire again while the key is held. Off by default so holding Delete removes one thing. */
  repeat?: boolean;
  /** Viewers that bind this shortcut. Omitted means the whole Studio. */
  viewers?: ViewerKind[];
  /** Only applies when the viewer offers at least one of these tools. */
  tools?: Tool[];
  /** Studio-wide shortcuts this one takes over in its viewers (e.g. arrows step frames, not items). */
  replaces?: string[];
  /**
   * Only claims its key in a particular state (e.g. while a polygon is being drawn)
   * and otherwise falls through to the Studio binding, so sharing a key is intended.
   */
  contextual?: boolean;
  /** Replaces the formatted keys in the UI, for families such as 1–9. */
  display?: string;
}

export type ShortcutGroup = "Edit" | "Navigate" | "Labels" | "Drawing" | "View" | "Playback" | "Help";
export const GROUP_ORDER: ShortcutGroup[] = ["Edit", "Navigate", "Labels", "Drawing", "View", "Playback", "Help"];

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const SIZED_TOOLS: Tool[] = ["brush", "eraser"];
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
const POLYGON_VIEWERS: ViewerKind[] = ["cine-4d", "pathology", "temporal"];
const VIDEO: ViewerKind[] = ["temporal"];
const PLAYBACK_VIEWERS: ViewerKind[] = ["temporal", "cine-4d"];

export const SHORTCUTS = {
  undo: { keys: ["mod+z"], label: "Undo", group: "Edit" },
  redo: { keys: ["shift+mod+z", "mod+y"], label: "Redo", group: "Edit" },
  deleteSelection: { keys: ["Backspace", "Delete"], label: "Delete selected annotations", group: "Edit" },
  deselect: { keys: ["Escape"], label: "Clear selection", group: "Edit" },
  selectAll: { keys: ["mod+a"], label: "Select every annotation on this item", group: "Edit" },

  nextItem: { keys: ["ArrowRight", "ArrowDown", "PageDown"], label: "Next item", group: "Navigate", repeat: true },
  prevItem: { keys: ["ArrowLeft", "ArrowUp", "PageUp"], label: "Previous item", group: "Navigate", repeat: true },

  pickLabel: { keys: DIGITS, label: "Pick label by position", group: "Labels", display: "1 – 9" },

  brushSmaller: { keys: ["["], label: "Smaller brush", group: "Drawing", repeat: true, tools: SIZED_TOOLS },
  brushLarger: { keys: ["]"], label: "Larger brush", group: "Drawing", repeat: true, tools: SIZED_TOOLS },
  finishShape: { keys: ["Enter"], label: "Close the polygon", group: "Drawing", viewers: POLYGON_VIEWERS, contextual: true },
  cancelShape: { keys: ["Escape"], label: "Cancel the shape in progress", group: "Drawing", viewers: POLYGON_VIEWERS, contextual: true },

  fitView: { keys: ["0"], label: "Fit image to view", group: "View", viewers: ["image-2d"] },
  fitViewCine: { keys: ["="], label: "Fit to view", group: "View", viewers: ["cine-4d", "volume-3d"] },
  toggleClassNames: { keys: ["n"], label: "Show or hide class names", group: "View", viewers: ["pathology"] },
  rotateView: { keys: ["shift+r"], label: "Rotate 90°", group: "View", viewers: ["pathology", "image-2d", "volume-3d"] },
  rotateViewLeft: { keys: ["shift+l"], label: "Rotate 90° left", group: "View", viewers: ["image-2d", "volume-3d"] },
  toggleMagnifier: { keys: ["m"], label: "Toggle magnifier", group: "View", viewers: ["image-2d", "volume-3d"] },
  invertImage: { keys: ["shift+i"], label: "Invert", group: "View", viewers: ["image-2d", "volume-3d"] },
  flipHorizontal: { keys: ["shift+h"], label: "Flip horizontally", group: "View", viewers: ["image-2d", "volume-3d"] },
  flipVertical: { keys: ["shift+v"], label: "Flip vertically", group: "View", viewers: ["image-2d", "volume-3d"] },
  holdToPan: { keys: ["space"], label: "Hold and drag to pan", group: "View", viewers: ["pathology", "cine-4d", "temporal", "image-2d", "volume-3d"], contextual: true },

  stepFrame: { keys: ["ArrowLeft", "ArrowRight"], display: "← →", label: "Previous or next frame", group: "Playback", viewers: ["cine-4d"], repeat: true, replaces: ["prevItem", "nextItem"] },
  stepSlice: { keys: ["ArrowUp", "ArrowDown"], display: "↑ ↓", label: "Previous or next slice", group: "Navigate", viewers: ["cine-4d", "volume-3d"], repeat: true },
  firstLastSlice: { keys: ["Home", "End"], display: "Home / End", label: "First or last slice", group: "Navigate", viewers: ["volume-3d"] },
  copyContourReplace: { keys: ["shift+alt+ArrowLeft", "shift+alt+ArrowRight", "shift+alt+ArrowUp", "shift+alt+ArrowDown"], display: `${IS_MAC ? "⇧⌥" : "Shift+Alt"} + arrows`, label: "Copy contour, replacing what is at the target", group: "Drawing", viewers: ["cine-4d"] },
  copyContour: { keys: ["alt+ArrowLeft", "alt+ArrowRight", "alt+ArrowUp", "alt+ArrowDown"], display: `${IS_MAC ? "⌥" : "Alt"} + arrows`, label: "Copy contour to the next frame or slice", group: "Drawing", viewers: ["cine-4d"] },
  removeLastVertex: { keys: ["Backspace"], label: "Remove the last vertex", group: "Drawing", viewers: ["pathology", "temporal"], contextual: true },

  playPause: { keys: ["space"], label: "Play or pause", group: "Playback", viewers: PLAYBACK_VIEWERS },
  prevFrame: { keys: [","], label: "Previous frame", group: "Playback", viewers: PLAYBACK_VIEWERS, repeat: true },
  nextFrame: { keys: ["."], label: "Next frame", group: "Playback", viewers: PLAYBACK_VIEWERS, repeat: true },

  scrollWindow: { keys: ["ArrowLeft", "ArrowRight", "shift+ArrowLeft", "shift+ArrowRight"], display: "← → (⇧ page)", label: "Scroll the time window", group: "Navigate", viewers: ["signal"], repeat: true },
  zoomTime: { keys: ["=", "+", "-"], display: "+ / −", label: "Zoom time (paper: speed)", group: "View", viewers: ["signal"], repeat: true },
  nextSuggestion: { keys: ["Tab"], label: "Next AI suggestion", group: "Edit", viewers: ["signal"], contextual: true },
  prevSuggestion: { keys: ["shift+Tab"], label: "Previous AI suggestion", group: "Edit", viewers: ["signal"], contextual: true },
  acceptSuggestion: { keys: ["Enter"], label: "Accept selected AI suggestions", group: "Edit", viewers: ["signal"], contextual: true },
  rejectSuggestion: { keys: ["Delete", "Backspace"], label: "Reject the AI suggestion and go to the next", group: "Edit", viewers: ["signal"], contextual: true },
  setBeatCode: { keys: ["shift+n", "shift+v", "shift+a", "shift+l", "shift+r", "shift+f", "shift+j", "shift+s", "shift+e", "shift+q", "shift+b", "/"], display: "⇧ N V A L R F J S E Q B · /", label: "Set code of selected beats", group: "Labels", viewers: ["signal"], contextual: true },
  clearCaliper: { keys: ["Escape"], label: "Clear caliper / close menu", group: "Drawing", viewers: ["signal"], contextual: true },

  videoStepFrame: { keys: ["ArrowLeft", "ArrowRight"], display: "← →", label: "Previous or next frame", group: "Playback", viewers: VIDEO, repeat: true, replaces: ["prevItem", "nextItem"] },
  videoStep10: { keys: ["shift+ArrowLeft", "shift+ArrowRight"], display: "⇧ ← →", label: "Back or forward 10 frames", group: "Playback", viewers: VIDEO, repeat: true },
  firstLastFrame: { keys: ["Home", "End"], display: "Home / End", label: "First or last frame (of the A–B range if set)", group: "Playback", viewers: VIDEO },
  toggleLoop: { keys: ["l"], label: "Loop playback", group: "Playback", viewers: VIDEO },
  fitVideo: { keys: ["f"], label: "Fit video to view", group: "View", viewers: VIDEO },
  toggleKeyframe: { keys: ["shift+k"], label: "Add or remove a keyframe on the selected tracks", group: "Drawing", viewers: VIDEO },
  toggleOutside: { keys: ["o"], label: "Mark selected tracks outside / back in view", group: "Drawing", viewers: VIDEO },
  toggleOccluded: { keys: ["shift+o"], label: "Toggle occluded on the selected tracks", group: "Drawing", viewers: VIDEO },
  prevKeyframe: { keys: ["alt+,"], label: "Previous keyframe", group: "Navigate", viewers: VIDEO },
  nextKeyframe: { keys: ["alt+."], label: "Next keyframe", group: "Navigate", viewers: VIDEO },
  copyToNextFrame: { keys: ["alt+b"], label: "Copy selected shapes to the next frame", group: "Drawing", viewers: VIDEO },
  addEvent: { keys: ["Enter"], label: "Mark an event at the current frame", group: "Drawing", viewers: VIDEO, tools: ["event"], contextual: true },

  showShortcuts: { keys: ["?"], label: "Keyboard shortcuts", group: "Help" },
} as const satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

/**
 * Single-key tool shortcuts. Keys only need to be unique within one viewer's tool
 * list; they follow OHIF / QuPath / CVAT conventions where those agree.
 */
export const TOOL_KEYS: Record<Tool, string> = {
  select: "v",
  pan: "h",
  zoom: "z",
  windowLevel: "w",
  crosshairs: "c",
  box: "r",
  ellipse: "o",
  polygon: "p",
  freehand: "f",
  polyline: "y",
  spline: "s",
  keypoint: "k",
  point: "k",
  mark: ".",
  length: "l",
  angle: "a",
  cobb: "j",
  bidirectional: "d",
  probe: "i",
  arrow: "x",
  brush: "b",
  eraser: "e",
  wand: "g",
  interval: "i",
  beat: "b",
  wave: "q",
  rhythm: "y",
  caliper: "c",
  segment: "s",
  event: "t",
};

/** Shortcuts that apply in a viewer with these tools: Studio-wide ones plus the viewer's own. */
export function shortcutsFor(viewer: ViewerKind, tools: Tool[]): [ShortcutId, ShortcutDef][] {
  const active = (Object.entries(SHORTCUTS) as [ShortcutId, ShortcutDef][]).filter(
    ([, d]) => (!d.viewers || d.viewers.includes(viewer)) && (!d.tools || d.tools.some((t) => tools.includes(t))),
  );
  const replaced = new Set(active.flatMap(([, d]) => d.replaces ?? []));
  return active.filter(([id]) => !replaced.has(id));
}

/** Combos bound twice in one viewer (ignoring intended contextual overlaps). Empty means no conflicts. */
export function findConflicts(viewer: ViewerKind, tools: Tool[]): string[] {
  const owners = new Map<string, string[]>();
  const claim = (combo: string, owner: string) => {
    const k = normalizeCombo(combo);
    owners.set(k, [...(owners.get(k) ?? []), owner]);
  };
  for (const [id, d] of shortcutsFor(viewer, tools)) if (!d.contextual) d.keys.forEach((k) => claim(k, id));
  for (const t of tools) claim(TOOL_KEYS[t], `tool:${t}`);
  return [...owners].filter(([, o]) => o.length > 1).map(([combo, o]) => `"${combo}" is bound to ${o.join(" and ")} in the ${viewer} viewer`);
}

export interface ParsedCombo {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const parsed = new Map<string, ParsedCombo>();

export function parseCombo(combo: string): ParsedCombo {
  let p = parsed.get(combo);
  if (!p) {
    // "+" on its own or at the end is the key itself, not a separator.
    const parts = combo.length > 1 && combo.endsWith("+") ? [...combo.slice(0, -2).split("+"), "+"] : combo.split("+");
    const key = parts.pop()!;
    const mods = new Set(parts.map((m) => m.toLowerCase()));
    p = { mod: mods.has("mod"), alt: mods.has("alt"), shift: mods.has("shift"), key: key.length === 1 ? key.toLowerCase() : key };
    parsed.set(combo, p);
  }
  return p;
}

function normalizeCombo(combo: string): string {
  const p = parseCombo(combo);
  return [p.mod && "mod", p.alt && "alt", p.shift && "shift", p.key].filter(Boolean).join("+");
}

const KEY_NAMES: Record<string, [mac: string, other: string]> = {
  ArrowUp: ["↑", "↑"],
  ArrowDown: ["↓", "↓"],
  ArrowLeft: ["←", "←"],
  ArrowRight: ["→", "→"],
  Escape: ["Esc", "Esc"],
  Delete: ["⌦", "Del"],
  Backspace: ["⌫", "Backspace"],
  Enter: ["↵", "Enter"],
  PageUp: ["PgUp", "PgUp"],
  PageDown: ["PgDn", "PgDn"],
  space: ["Space", "Space"],
};

/** Display parts for one combo, e.g. ["⇧", "⌘", "Z"] on macOS or ["Shift", "Ctrl", "Z"] elsewhere. */
export function comboParts(combo: string): string[] {
  const p = parseCombo(combo);
  const name = KEY_NAMES[p.key]?.[IS_MAC ? 0 : 1] ?? p.key.toUpperCase();
  return [
    p.shift && (IS_MAC ? "⇧" : "Shift"),
    p.alt && (IS_MAC ? "⌥" : "Alt"),
    p.mod && (IS_MAC ? "⌘" : "Ctrl"),
    name,
  ].filter((x): x is string => !!x);
}

/** One combo as a single string: "⇧⌘Z" on macOS, "Shift+Ctrl+Z" elsewhere. */
export function formatCombo(combo: string): string {
  return comboParts(combo).join(IS_MAC ? "" : "+");
}

/** The UI string for a shortcut id: its `display`, else its first combo. */
export function shortcutLabel(id: ShortcutId): string {
  const d: ShortcutDef = SHORTCUTS[id];
  return d.display ?? formatCombo(d.keys[0]);
}
