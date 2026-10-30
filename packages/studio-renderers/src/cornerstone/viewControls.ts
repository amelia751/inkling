import { Enums, type Types } from "@cornerstonejs/core";

export type VoiRange = { lower: number; upper: number };

/** OHIF's CT window presets (W/L). Only offered when the modality is CT. */
export const CT_PRESETS: { id: string; label: string; window: number; level: number }[] = [
  { id: "soft", label: "Soft tissue", window: 400, level: 40 },
  { id: "lung", label: "Lung", window: 1500, level: -600 },
  { id: "liver", label: "Liver", window: 150, level: 90 },
  { id: "bone", label: "Bone", window: 2500, level: 480 },
  { id: "brain", label: "Brain", window: 80, level: 40 },
];

export const COLORMAPS: { value: string; label: string }[] = [
  { value: "Grayscale", label: "Grayscale" },
  { value: "Black-Body Radiation", label: "Hot iron" },
  { value: "Inferno (matplotlib)", label: "Inferno" },
  { value: "Viridis (matplotlib)", label: "Viridis" },
  { value: "jet", label: "Jet" },
];

export function wlToRange(window: number, level: number): VoiRange {
  return { lower: level - window / 2, upper: level + window / 2 };
}

/** Robust display window from sampled percentiles (ignores zero background, like MRI viewers do). */
export function percentileVoi(data: ArrayLike<number>, lo = 0.005, hi = 0.995, ignoreZero = true): VoiRange {
  const step = Math.max(1, Math.floor(data.length / 250_000));
  const sample: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (!ignoreZero || v !== 0) sample.push(v);
  }
  if (!sample.length) return { lower: 0, upper: 1 };
  sample.sort((a, b) => a - b);
  const lower = sample[Math.floor((sample.length - 1) * lo)];
  const upper = sample[Math.floor((sample.length - 1) * hi)];
  return { lower, upper: upper > lower ? upper : lower + 1 };
}

export function fullRange(data: ArrayLike<number>): VoiRange {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return { lower: 0, upper: 1 };
  return { lower: min, upper: max > min ? max : min + 1 };
}

/** Any Cornerstone viewport (stack, volume…); the class hierarchy is not structurally compatible. */
export type AnyViewport = Types.IViewport | Types.IVolumeViewport | Types.IStackViewport;

type PropViewport = Types.IViewport & {
  setProperties(p: Record<string, unknown>, ...rest: unknown[]): void;
  getProperties(): { voiRange?: VoiRange; invert?: boolean; colormap?: { name?: string }; interpolationType?: number };
};

const asProps = (vp: AnyViewport) => vp as unknown as PropViewport;
const base = (vp: AnyViewport) => vp as unknown as Types.IViewport;

export function getVoi(vp: AnyViewport): VoiRange | undefined {
  try {
    return asProps(vp).getProperties()?.voiRange;
  } catch {
    return undefined;
  }
}

export function setVoi(vp: AnyViewport, voiRange: VoiRange) {
  asProps(vp).setProperties({ voiRange });
  base(vp).render();
}

export function getInvert(vp: AnyViewport): boolean {
  try {
    return !!asProps(vp).getProperties()?.invert;
  } catch {
    return false;
  }
}

export function setInvert(vp: AnyViewport, invert: boolean) {
  asProps(vp).setProperties({ invert });
  base(vp).render();
}

export function setColormap(vp: AnyViewport, name: string) {
  asProps(vp).setProperties({ colormap: { name } });
  base(vp).render();
}

export function setInterpolation(vp: AnyViewport, linear: boolean) {
  asProps(vp).setProperties({ interpolationType: linear ? Enums.InterpolationType.LINEAR : Enums.InterpolationType.NEAREST });
  base(vp).render();
}

export function flip(vp: AnyViewport, axis: "h" | "v") {
  const cam = base(vp).getCamera();
  base(vp).setCamera(axis === "h" ? { flipHorizontal: !cam.flipHorizontal } : { flipVertical: !cam.flipVertical });
  base(vp).render();
}

export function rotate(vp: AnyViewport, delta: number) {
  const current = base(vp).getViewPresentation({ rotation: true })?.rotation ?? 0;
  base(vp).setViewPresentation({ rotation: (((current + delta) % 360) + 360) % 360 });
  base(vp).render();
}

export function resetView(vp: AnyViewport) {
  base(vp).resetCamera();
  base(vp).setViewPresentation({ rotation: 0 });
  const cam = base(vp).getCamera();
  if (cam.flipHorizontal || cam.flipVertical) base(vp).setCamera({ flipHorizontal: false, flipVertical: false });
  base(vp).render();
}

export function formatWL(voi: VoiRange | undefined): string {
  if (!voi) return "";
  const w = voi.upper - voi.lower;
  const l = (voi.upper + voi.lower) / 2;
  const f = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toString() : n.toFixed(1));
  return `W ${f(w)} L ${f(l)}`;
}
