import * as z from "zod";
import { ns } from "@studio/plugin-contracts/naming";

/**
 * Contract between the Cornerstone stack renderer and its viewport-bar panel. The renderer
 * publishes a plain state snapshot (`VIEW_STATE`) and a stable action object
 * (`VIEW_CONTROLS`) in the item's runtime; the panel reads both with `useRuntime`. Pure
 * data and types only, so the panel never pulls Cornerstone into the main bundle.
 */
export const VIEW_STATE = "image2d.view";
export const VIEW_CONTROLS = "image2d.controls";

/** OHIF's CT window presets (W/L), offered only when the modality is CT. */
export const DEFAULT_CT_PRESETS = [
  { id: "soft", label: "Soft tissue", window: 400, level: 40 },
  { id: "lung", label: "Lung", window: 1500, level: -600 },
  { id: "liver", label: "Liver", window: 150, level: 90 },
  { id: "bone", label: "Bone", window: 2500, level: 480 },
  { id: "brain", label: "Brain", window: 80, level: 40 },
];

export const DEFAULT_COLORMAPS = [
  { value: "Grayscale", label: "Grayscale" },
  { value: "Black-Body Radiation", label: "Hot iron" },
  { value: "Inferno (matplotlib)", label: "Inferno" },
  { value: "Viridis (matplotlib)", label: "Viridis" },
  { value: "jet", label: "Jet" },
];

const flag = (what: string) => z.boolean().default(true).describe(what);

/** Config of `inkling.image2d.renderers.cornerstone-stack`: each viewport-bar control and its keys can be switched off. */
export const StackConfigSchema = z.object({
  windowLevel: flag("Window/level presets and the W/L readout; false for natural photos"),
  invert: flag("Invert button and its key"),
  flip: flag("Flip horizontal / vertical buttons and keys"),
  rotate: flag("Rotate buttons and keys"),
  colormap: flag("Color map picker"),
  interpolation: flag("Smooth / nearest-neighbour toggle"),
  magnifier: flag("Hover magnifier button and key"),
  colormaps: z.array(z.object({ value: z.string(), label: z.string() })).default(DEFAULT_COLORMAPS).describe("Cornerstone color map names offered in the picker"),
  ctPresets: z
    .array(z.object({ id: z.string(), label: z.string(), window: z.number(), level: z.number() }))
    .default(DEFAULT_CT_PRESETS)
    .describe("Window/level presets offered when the image's modality is CT"),
});
export type StackConfig = z.infer<typeof StackConfigSchema>;

export type WandMode = "flood" | "smart";

export interface ViewState {
  features: Pick<StackConfig, "windowLevel" | "invert" | "flip" | "rotate" | "colormap" | "interpolation" | "magnifier">;
  invert: boolean;
  colormap: string;
  colormaps: StackConfig["colormaps"];
  linear: boolean;
  magnify: boolean;
  wandMode: WandMode;
  /** Window/level options for the preset picker ("" = placeholder). */
  voiOptions: { value: string; label: string }[];
  /** "mm" when the image carries pixel spacing, else "px". */
  unit: string;
}

export interface ViewControls {
  toggleInvert: () => void;
  flip: (axis: "h" | "v") => void;
  rotate: (degrees: number) => void;
  reset: () => void;
  setColormap: (name: string) => void;
  toggleInterpolation: () => void;
  applyVoiPreset: (id: string) => void;
  toggleMagnifier: () => void;
  setWandMode: (mode: WandMode) => void;
  removeIslands: () => void;
}

/** Full ids of the commands the stack renderer handles (the panel shows their keys). */
export const COMMANDS = {
  invert: ns("cornerstone.commands.invertImage"),
  flipH: ns("cornerstone.commands.flipHorizontal"),
  flipV: ns("cornerstone.commands.flipVertical"),
  rotateLeft: ns("cornerstone.commands.rotateViewLeft"),
  rotateRight: ns("core.commands.rotateView"),
  magnifier: ns("cornerstone.commands.toggleMagnifier"),
  fit: ns("image2d.commands.fitView"),
} as const;
