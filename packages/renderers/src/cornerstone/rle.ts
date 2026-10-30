/**
 * Run-length encoding for `mask` geometry (see src/types): runs over the flattened grid
 * (x fastest), alternating background / foreground, starting with background.
 * Pure module: safe to import from adapters without pulling in Cornerstone.
 */
export interface EncodedMask {
  counts: number[];
  voxels: number;
}

/** Encode every element equal to `value` as foreground. */
export function encodeMask(data: ArrayLike<number>, value: number): EncodedMask {
  const counts: number[] = [];
  let fg = false;
  let run = 0;
  let voxels = 0;
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const on = data[i] === value;
    if (on !== fg) {
      counts.push(run);
      run = 0;
      fg = on;
    }
    run++;
    if (on) voxels++;
  }
  counts.push(run);
  return { counts, voxels };
}

/** Call `fn(start, end)` for each foreground run (end exclusive). */
export function forEachRun(counts: number[], fn: (start: number, end: number) => void) {
  let at = 0;
  for (let r = 0; r < counts.length; r++) {
    const next = at + counts[r];
    if (r % 2 === 1) fn(at, next);
    at = next;
  }
}

/** Write `value` into `out` wherever the mask is foreground. */
export function decodeMaskInto(counts: number[], out: { [i: number]: number; length: number }, value: number) {
  forEachRun(counts, (s, e) => {
    const end = Math.min(e, out.length);
    for (let i = s; i < end; i++) out[i] = value;
  });
}

export function sameCounts(a: number[] | undefined, b: number[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Deterministic id for the one mask annotation each (item, label) owns. */
export function maskId(itemId: string, label: string): string {
  return `mask:${itemId}:${label}`;
}

/**
 * COCO "uncompressed RLE" is column-major (y fastest) and starts with background.
 * Converts our row-major runs for a w×h image.
 */
export function toCocoRle(counts: number[], w: number, h: number): { size: [number, number]; counts: number[] } {
  const grid = new Uint8Array(w * h);
  decodeMaskInto(counts, grid, 1);
  const out: number[] = [];
  let fg = 0;
  let run = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const v = grid[y * w + x];
      if (v !== fg) {
        out.push(run);
        run = 0;
        fg = v;
      }
      run++;
    }
  }
  out.push(run);
  return { size: [h, w], counts: out };
}
