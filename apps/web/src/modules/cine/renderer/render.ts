import type { Volume } from "@/kits/io/nifti";

export type Rgb = [number, number, number];

/** [lo, hi] percentiles of the non-zero voxels (sampled), e.g. 1–99 for the "Auto" preset. */
export function percentileWindow(data: Float32Array, loPct: number, hiPct: number): [number, number] {
  const step = Math.max(1, Math.floor(data.length / 250_000));
  const sample: number[] = [];
  for (let i = 0; i < data.length; i += step) if (data[i] !== 0) sample.push(data[i]);
  if (!sample.length) return [0, 1];
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor((sample.length - 1) * loPct / 100)];
  const hi = sample[Math.floor((sample.length - 1) * hiPct / 100)];
  return [lo, hi > lo ? hi : lo + 1];
}

export function fullRange(data: Float32Array): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi > lo ? hi : lo + 1];
}

function ensure(canvas: HTMLCanvasElement | null, w: number, h: number) {
  const c = canvas ?? document.createElement("canvas");
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return c;
}

/** Grey-scale slice (one frame) with window [lo, hi], into a reusable voxel-sized canvas. */
export function renderSlice(vol: Volume, slice: number, frame: number, lo: number, hi: number, invert: boolean, target: HTMLCanvasElement | null) {
  const [nx, ny, nz] = vol.dims;
  const c = ensure(target, nx, ny);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(nx, ny);
  const base = frame * nx * ny * nz + slice * nx * ny;
  const k = 255 / (hi - lo || 1);
  for (let p = 0; p < nx * ny; p++) {
    let g = (vol.data[base + p] - lo) * k;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    if (invert) g = 255 - g;
    const o = p * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Colour a label map (value → colour) into a voxel-sized canvas. `outline` keeps only
 * pixels on a label boundary, which is how the reference segmentation is shown.
 */
export function renderLabelMap(map: ArrayLike<number>, offset: number, nx: number, ny: number, colors: (Rgb | null)[], alpha: number, outline: boolean, target: HTMLCanvasElement | null) {
  const c = ensure(target, nx, ny);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(nx, ny);
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p = j * nx + i;
      const v = map[offset + p];
      if (!v) continue;
      const rgb = colors[v];
      if (!rgb) continue;
      if (outline) {
        const edge =
          i === 0 || j === 0 || i === nx - 1 || j === ny - 1 ||
          map[offset + p - 1] !== v || map[offset + p + 1] !== v || map[offset + p - nx] !== v || map[offset + p + nx] !== v;
        if (!edge) continue;
      }
      const o = p * 4;
      img.data[o] = rgb[0];
      img.data[o + 1] = rgb[1];
      img.data[o + 2] = rgb[2];
      img.data[o + 3] = outline ? 255 : a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Nearest-neighbour thumbnail of one slice/frame into a small canvas. */
export function renderThumb(vol: Volume, slice: number, frame: number, lo: number, hi: number, canvas: HTMLCanvasElement) {
  const [nx, ny, nz] = vol.dims;
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  const base = frame * nx * ny * nz + slice * nx * ny;
  const k = 255 / (hi - lo || 1);
  for (let y = 0; y < h; y++) {
    const j = Math.min(ny - 1, Math.floor(((y + 0.5) * ny) / h));
    for (let x = 0; x < w; x++) {
      const i = Math.min(nx - 1, Math.floor(((x + 0.5) * nx) / w));
      let g = (vol.data[base + j * nx + i] - lo) * k;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
