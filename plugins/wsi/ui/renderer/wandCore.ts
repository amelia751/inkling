/**
 * Pure wand pixel code, shared by the Web Worker (wand.worker.ts) and the inline fallback.
 * No DOM access here.
 */
import { maskToRegion, type Region } from "@studio/renderers/overlay2d/regions";

export interface Adjustments {
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
}

export const NEUTRAL_ADJUST: Adjustments = { brightness: 1, contrast: 1, saturation: 1, gamma: 1 };

export interface WandJob {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  sx: number;
  sy: number;
  tolerance: number;
  adj: Adjustments;
  /** Image position of the window origin and window px per image px. */
  ox: number;
  oy: number;
  k: number;
}

/** Adjust → blur → flood fill → trace. Returns the region in level-0 image px. */
export function runWandJob(j: WandJob): Region {
  adjustPixels(j.rgba, j.adj);
  const mask = floodFill(j.rgba, j.w, j.h, j.sx, j.sy, j.tolerance);
  // Holes under ~0.1% of the region (or 64 px) are noise: fill them.
  let fg = 0;
  for (let i = 0; i < mask.length; i++) fg += mask[i];
  return maskToRegion(mask, j.w, j.h, j.ox, j.oy, j.k, 0.8, 12, Math.max(64, fg * 0.001));
}

/** Same math as the CSS filters on the slide (brightness → contrast → saturate → gamma). */
export function adjustPixels(px: Uint8ClampedArray, adj: Adjustments) {
  if (adj.brightness === 1 && adj.contrast === 1 && adj.saturation === 1 && adj.gamma === 1) return;
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = (i / 255) * adj.brightness;
    v = (v - 0.5) * adj.contrast + 0.5;
    lut[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  const s = adj.saturation;
  // CSS saturate() matrix (Rec. 709 luma).
  const m = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  const g = 1 / adj.gamma;
  const glut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) glut[i] = Math.round(255 * Math.pow(i / 255, g));
  for (let i = 0; i < px.length; i += 4) {
    const r = lut[px[i]], gg = lut[px[i + 1]], b = lut[px[i + 2]];
    px[i] = glut[Math.max(0, Math.min(255, Math.round(m[0] * r + m[1] * gg + m[2] * b)))];
    px[i + 1] = glut[Math.max(0, Math.min(255, Math.round(m[3] * r + m[4] * gg + m[5] * b)))];
    px[i + 2] = glut[Math.max(0, Math.min(255, Math.round(m[6] * r + m[7] * gg + m[8] * b)))];
  }
}

/** Separable running-mean blur of one channel (radius r), in place via `tmp`. */
function boxBlur(src: Float32Array, tmp: Float32Array, w: number, h: number, r: number) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0, n = 0;
    for (let x = -r; x < w; x++) {
      const add = x + r, sub = x - r - 1;
      if (add < w) {
        acc += src[row + add];
        n++;
      }
      if (sub >= 0) {
        acc -= src[row + sub];
        n--;
      }
      if (x >= 0) tmp[row + x] = acc / n;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0, n = 0;
    for (let y = -r; y < h; y++) {
      const add = y + r, sub = y - r - 1;
      if (add < h) {
        acc += tmp[add * w + x];
        n++;
      }
      if (sub >= 0) {
        acc -= tmp[sub * w + x];
        n--;
      }
      if (y >= 0) src[y * w + x] = acc / n;
    }
  }
}

/** Binary dilation (grow=true) or erosion with a (2r+1)² square, separable. */
function morph(mask: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  const hit = grow ? 1 : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const xx = x + d;
        const m = xx < 0 || xx >= w ? (grow ? 0 : 1) : mask[y * w + xx];
        if (m === hit) {
          v = hit;
          break;
        }
      }
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const yy = y + d;
        const m = yy < 0 || yy >= h ? (grow ? 0 : 1) : tmp[yy * w + x];
        if (m === hit) {
          v = hit;
          break;
        }
      }
      out[y * w + x] = v;
    }
  return out;
}

/**
 * QuPath-style wand on screen-resolution pixels: smooth (two box passes ≈ Gaussian σ 2.5 px)
 * so the fill follows tissue texture rather than single nuclei, 4-connected flood fill
 * within `tolerance` (RGB distance) of the smoothed seed colour, then a morphological
 * close (radius 2) to bridge thin gaps.
 */
export function floodFill(rgba: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, tolerance: number, smooth = 3): Uint8Array {
  const n = w * h;
  const ch = [0, 1, 2].map((c) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = rgba[i * 4 + c];
    return a;
  });
  const tmp = new Float32Array(n);
  if (smooth > 0) for (const a of ch) for (let pass = 0; pass < 2; pass++) boxBlur(a, tmp, w, h, smooth);
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = ch[0][i];
    rgb[i * 3 + 1] = ch[1][i];
    rgb[i * 3 + 2] = ch[2][i];
  }
  const s = (sy * w + sx) * 3;
  const r0 = rgb[s], g0 = rgb[s + 1], b0 = rgb[s + 2];
  const tol2 = tolerance * tolerance;
  const ok = (i: number) => {
    const o = i * 3;
    const dr = rgb[o] - r0, dg = rgb[o + 1] - g0, db = rgb[o + 2] - b0;
    return dr * dr + dg * dg + db * db <= tol2;
  };
  const mask = new Uint8Array(n);
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!, x0 = stack.pop()!;
    let x = x0;
    const row = y * w;
    if (mask[row + x] || !ok(row + x)) continue;
    while (x > 0 && !mask[row + x - 1] && ok(row + x - 1)) x--;
    let up = false, down = false;
    for (; x < w && !mask[row + x] && ok(row + x); x++) {
      mask[row + x] = 1;
      if (y > 0) {
        const can = !mask[row - w + x] && ok(row - w + x);
        if (can && !up) stack.push(x, y - 1);
        up = can;
      }
      if (y < h - 1) {
        const can = !mask[row + w + x] && ok(row + w + x);
        if (can && !down) stack.push(x, y + 1);
        down = can;
      }
    }
  }
  return smooth > 0 ? morph(morph(mask, w, h, 2, true), w, h, 2, false) : mask;
}
