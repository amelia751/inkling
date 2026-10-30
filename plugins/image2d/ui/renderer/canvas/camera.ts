import type { Pt } from "@studio/plugin-contracts/types";

/**
 * Pan/zoom camera of the canvas-raster renderer: image pixel (x, y) maps to screen CSS
 * pixel (tx + x·scale, ty + y·scale). Pure functions so the math is unit-tested.
 */
export interface Camera {
  scale: number;
  tx: number;
  ty: number;
}

export const MIN_ZOOM = 1 / 64;
export const MAX_ZOOM = 64;

/** Whole image centred in the viewport with a small margin. */
export function fitCamera(imageW: number, imageH: number, viewW: number, viewH: number, margin = 0.96): Camera {
  if (!imageW || !imageH || !viewW || !viewH) return { scale: 1, tx: 0, ty: 0 };
  const scale = Math.min(viewW / imageW, viewH / imageH) * margin;
  return { scale, tx: (viewW - imageW * scale) / 2, ty: (viewH - imageH * scale) / 2 };
}

/** Zoom by `factor` keeping screen point (sx, sy) fixed; scale is clamped relative to `fit`. */
export function zoomAbout(c: Camera, factor: number, sx: number, sy: number, fit = 1): Camera {
  const scale = Math.min(fit * MAX_ZOOM, Math.max(fit * MIN_ZOOM, c.scale * factor));
  const k = scale / c.scale;
  return { scale, tx: sx - (sx - c.tx) * k, ty: sy - (sy - c.ty) * k };
}

export function panBy(c: Camera, dx: number, dy: number): Camera {
  return { ...c, tx: c.tx + dx, ty: c.ty + dy };
}

export function toScreen(c: Camera, x: number, y: number): Pt {
  return [c.tx + x * c.scale, c.ty + y * c.scale];
}

export function toImage(c: Camera, sx: number, sy: number): Pt {
  return [(sx - c.tx) / c.scale, (sy - c.ty) / c.scale];
}
