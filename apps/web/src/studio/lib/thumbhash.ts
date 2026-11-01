/**
 * ThumbHash decoder (Evan Wallace's format, https://evanw.github.io/thumbhash/, MIT): turns the
 * worker's ~25-byte hash into a small blurred RGBA image with the right aspect ratio, shown
 * while an item's thumbnail loads (todo11 Milestone 3).
 */

export function thumbHashAspect(hash: Uint8Array): number {
  const header = hash[3];
  const hasAlpha = hash[2] & 0x80;
  const isLandscape = hash[4] & 0x80;
  const lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7;
  const ly = isLandscape ? header & 7 : hasAlpha ? 5 : 7;
  return lx / ly;
}

export function thumbHashToRGBA(hash: Uint8Array): { w: number; h: number; rgba: Uint8ClampedArray<ArrayBuffer> } {
  const { PI, min, max, cos, round } = Math;
  const header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const header16 = hash[3] | (hash[4] << 8);
  const lDc = (header24 & 63) / 63;
  const pDc = ((header24 >> 6) & 63) / 31.5 - 1;
  const qDc = ((header24 >> 12) & 63) / 31.5 - 1;
  const lScale = ((header24 >> 18) & 31) / 31;
  const hasAlpha = header24 >> 23;
  const pScale = ((header16 >> 3) & 63) / 63;
  const qScale = ((header16 >> 9) & 63) / 63;
  const isLandscape = header16 >> 15;
  const lx = max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7);
  const ly = max(3, isLandscape ? header16 & 7 : hasAlpha ? 5 : 7);
  const aDc = hasAlpha ? (hash[5] & 15) / 15 : 1;
  const aScale = (hash[5] >> 4) / 15;
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  const decode = (nx: number, ny: number, scale: number) => {
    const ac: number[] = [];
    for (let cy = 0; cy < ny; cy++)
      for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++) {
        ac.push((((hash[acStart + (acIndex >> 1)] >> ((acIndex & 1) << 2)) & 15) / 7.5 - 1) * scale);
        acIndex++;
      }
    return ac;
  };
  const lAc = decode(lx, ly, lScale);
  const pAc = decode(3, 3, pScale * 1.25);
  const qAc = decode(3, 3, qScale * 1.25);
  const aAc = hasAlpha ? decode(5, 5, aScale) : [];
  const ratio = thumbHashAspect(hash);
  const w = round(ratio > 1 ? 32 : 32 * ratio);
  const h = round(ratio > 1 ? 32 / ratio : 32);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const fx: number[] = [];
  const fy: number[] = [];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let l = lDc, p = pDc, q = qDc, a = aDc;
      for (let cx = 0, n = max(lx, hasAlpha ? 5 : 3); cx < n; cx++) fx[cx] = cos((PI / w) * (x + 0.5) * cx);
      for (let cy = 0, n = max(ly, hasAlpha ? 5 : 3); cy < n; cy++) fy[cy] = cos((PI / h) * (y + 0.5) * cy);
      for (let cy = 0, j = 0; cy < ly; cy++) for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx * ly < lx * (ly - cy); cx++, j++) l += lAc[j] * fx[cx] * fy2;
      for (let cy = 0, j = 0; cy < 3; cy++)
        for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx < 3 - cy; cx++, j++) {
          const f = fx[cx] * fy2;
          p += pAc[j] * f;
          q += qAc[j] * f;
        }
      if (hasAlpha) for (let cy = 0, j = 0; cy < 5; cy++) for (let cx = cy ? 0 : 1, fy2 = fy[cy] * 2; cx < 5 - cy; cx++, j++) a += aAc[j] * fx[cx] * fy2;
      const b = l - (2 / 3) * p;
      const r = (3 * l - b + q) / 2;
      const g = r - q;
      rgba[i] = max(0, 255 * min(1, r));
      rgba[i + 1] = max(0, 255 * min(1, g));
      rgba[i + 2] = max(0, 255 * min(1, b));
      rgba[i + 3] = max(0, 255 * min(1, a));
    }
  }
  return { w, h, rgba };
}

export function decodeBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const urls = new Map<string, string>();

/** A data URL for a base64 ThumbHash (cached), or null where there is no canvas. */
export function thumbHashDataUrl(b64: string): string | null {
  const hit = urls.get(b64);
  if (hit) return hit;
  if (typeof document === "undefined") return null;
  try {
    const { w, h, rgba } = thumbHashToRGBA(decodeBase64(b64));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
    const url = c.toDataURL();
    urls.set(b64, url);
    return url;
  } catch {
    return null;
  }
}
