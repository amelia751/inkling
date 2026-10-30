/**
 * Plain-array region operations used by the 2D and 3D viewers on top of Cornerstone
 * labelmaps: magic-wand flood fill, island removal and slice interpolation fallback.
 * Everything here works on flattened grids (x fastest).
 */

/**
 * 4-connected flood fill on one slice from (sx, sy), accepting pixels whose value is
 * within `tolerance` of the seed. Returns slice-local indices (y * w + x), or null if
 * the region grows past `maxPixels` (likely leaked into background).
 */
export function floodFill2D(
  w: number,
  h: number,
  sx: number,
  sy: number,
  value: (x: number, y: number) => number,
  tolerance: number,
  maxPixels = Math.floor(w * h * 0.5),
): number[] | null {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return [];
  const seed = value(sx, sy);
  const seen = new Uint8Array(w * h);
  const out: number[] = [];
  const stack = [sy * w + sx];
  seen[sy * w + sx] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (Math.abs(value(x, y) - seed) > tolerance) continue;
    out.push(i);
    if (out.length > maxPixels) return null;
    if (x > 0 && !seen[i - 1]) (seen[i - 1] = 1), stack.push(i - 1);
    if (x < w - 1 && !seen[i + 1]) (seen[i + 1] = 1), stack.push(i + 1);
    if (y > 0 && !seen[i - w]) (seen[i - w] = 1), stack.push(i - w);
    if (y < h - 1 && !seen[i + w]) (seen[i + w] = 1), stack.push(i + w);
  }
  return out;
}

/**
 * Keep only the largest connected component (6-connected in 3D, 4 in 2D) of `seg`.
 * Mutates `data`; returns the number of voxels removed.
 */
export function removeIslands(data: { [i: number]: number; length: number }, dims: number[], seg: number): number {
  const [nx, ny, nz = 1] = dims;
  const n = nx * ny * nz;
  const comp = new Int32Array(n);
  const sizes: number[] = [0];
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (data[start] !== seg || comp[start]) continue;
    const id = sizes.length;
    let size = 0;
    comp[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % nx;
      const y = Math.floor(i / nx) % ny;
      const z = Math.floor(i / (nx * ny));
      const visit = (j: number) => {
        if (data[j] === seg && !comp[j]) {
          comp[j] = id;
          stack.push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < nx - 1) visit(i + 1);
      if (y > 0) visit(i - nx);
      if (y < ny - 1) visit(i + nx);
      if (z > 0) visit(i - nx * ny);
      if (z < nz - 1) visit(i + nx * ny);
    }
    sizes.push(size);
  }
  if (sizes.length <= 2) return 0;
  let keep = 1;
  for (let c = 2; c < sizes.length; c++) if (sizes[c] > sizes[keep]) keep = c;
  let removed = 0;
  for (let i = 0; i < n; i++) {
    if (comp[i] && comp[i] !== keep) {
      data[i] = 0;
      removed++;
    }
  }
  return removed;
}

/** Approximate signed distance (chamfer 3-4) of one binary slice: negative inside. */
function signedDistance(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const dist = (inside: boolean) => {
    const d = new Float32Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = (mask[i] === 1) === inside ? 0 : INF;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let v = d[i];
        if (x > 0) v = Math.min(v, d[i - 1] + 3);
        if (y > 0) {
          v = Math.min(v, d[i - w] + 3);
          if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
          if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
        }
        d[i] = v;
      }
    for (let y = h - 1; y >= 0; y--)
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let v = d[i];
        if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
        if (y < h - 1) {
          v = Math.min(v, d[i + w] + 3);
          if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
          if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
        }
        d[i] = v;
      }
    return d;
  };
  const outside = dist(true); // distance to nearest inside pixel
  const inside = dist(false); // distance to nearest outside pixel
  const sd = new Float32Array(w * h);
  for (let i = 0; i < sd.length; i++) sd[i] = mask[i] ? -inside[i] / 3 : outside[i] / 3;
  return sd;
}

/**
 * Shape-based interpolation along `axis` (0, 1 or 2) between consecutive annotated slices
 * of `seg`: blends the signed distance maps of the two bounding slices. Only fills empty
 * voxels. Mutates `data`; returns the number of voxels added.
 */
export function interpolateSlices(data: { [i: number]: number; length: number }, dims: number[], seg: number, axis = 2): number {
  const [nx, ny, nz] = dims;
  const size = [nx, ny, nz];
  const [ua, va] = [0, 1, 2].filter((a) => a !== axis);
  const w = size[ua], h = size[va], depth = size[axis];
  const stride = [1, nx, nx * ny];
  const index = (u: number, v: number, s: number) => u * stride[ua] + v * stride[va] + s * stride[axis];
  const sliceMask = (s: number) => {
    const m = new Uint8Array(w * h);
    let any = false;
    for (let v = 0; v < h; v++)
      for (let u = 0; u < w; u++)
        if (data[index(u, v, s)] === seg) {
          m[v * w + u] = 1;
          any = true;
        }
    return any ? m : null;
  };
  const annotated: number[] = [];
  const masks = new Map<number, Uint8Array>();
  for (let s = 0; s < depth; s++) {
    const m = sliceMask(s);
    if (m) {
      annotated.push(s);
      masks.set(s, m);
    }
  }
  let added = 0;
  for (let k = 0; k + 1 < annotated.length; k++) {
    const a = annotated[k], b = annotated[k + 1];
    if (b - a < 2) continue;
    const da = signedDistance(masks.get(a)!, w, h);
    const db = signedDistance(masks.get(b)!, w, h);
    for (let s = a + 1; s < b; s++) {
      const t = (s - a) / (b - a);
      for (let v = 0; v < h; v++)
        for (let u = 0; u < w; u++) {
          const p = v * w + u;
          if ((1 - t) * da[p] + t * db[p] < 0) {
            const i = index(u, v, s);
            if (data[i] === 0) {
              data[i] = seg;
              added++;
            }
          }
        }
    }
  }
  return added;
}

/**
 * "Smart fill": confidence-connected region growing (as in ITK / 3D Slicer). Starting from
 * the seed's neighbourhood statistics, grow the connected region whose intensities lie in
 * mean ± multiplier·σ, then re-estimate mean/σ from that region and grow again. Adapts to
 * the structure's own contrast instead of a fixed tolerance. No model, runs on the CPU.
 *
 * `dims` is [nx, ny, nz]; with `planeAxis` set the region stays on the seed's slice
 * through that axis (2D images use nz = 1). Returns flat indices, or null if the region
 * exceeds `maxVoxels` (leaked into background).
 */
export function confidenceConnected(
  dims: number[],
  seed: number[],
  value: (index: number) => number,
  {
    multiplier = 2.5,
    iterations = 4,
    seedRadius = 2,
    maxVoxels = 2_000_000,
    reach = Infinity,
    planeAxis,
  }: { multiplier?: number; iterations?: number; seedRadius?: number; maxVoxels?: number; reach?: number; planeAxis?: 0 | 1 | 2 } = {},
): number[] | null {
  const [nx, ny, nz = 1] = dims;
  const n = [nx, ny, nz];
  const stride = [1, nx, nx * ny];
  const s = seed.map((v, a) => Math.max(0, Math.min(n[a] - 1, Math.round(v))));
  const fixed = (a: number) => a === planeAxis || n[a] === 1;
  const lo = s.map((v, a) => (fixed(a) ? v : Math.max(0, v - reach)));
  const hi = s.map((v, a) => (fixed(a) ? v : Math.min(n[a] - 1, v + reach)));
  const index = (p: number[]) => p[0] + p[1] * stride[1] + p[2] * stride[2];

  // Seed neighbourhood statistics.
  let sum = 0, sq = 0, cnt = 0;
  for (let k = Math.max(lo[2], s[2] - seedRadius); k <= Math.min(hi[2], s[2] + seedRadius); k++)
    for (let j = Math.max(lo[1], s[1] - seedRadius); j <= Math.min(hi[1], s[1] + seedRadius); j++)
      for (let i = Math.max(lo[0], s[0] - seedRadius); i <= Math.min(hi[0], s[0] + seedRadius); i++) {
        const v = value(index([i, j, k]));
        sum += v;
        sq += v * v;
        cnt++;
      }
  let mean = sum / cnt;
  let std = Math.sqrt(Math.max(0, sq / cnt - mean * mean));
  let region: number[] = [];
  for (let it = 0; it < iterations; it++) {
    // A perfectly flat seed patch would give σ = 0; keep a small band.
    const band = Math.max(multiplier * std, Math.abs(mean) * 0.02, 1e-3);
    const lower = mean - band, upper = mean + band;
    const seen = new Uint8Array(nx * ny * nz);
    const start = index(s);
    const stack = [start];
    seen[start] = 1;
    region = [];
    let rs = 0, rsq = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      const v = value(idx);
      if (v < lower || v > upper) continue;
      region.push(idx);
      rs += v;
      rsq += v * v;
      if (region.length > maxVoxels) return null;
      const i = idx % nx, j = Math.floor(idx / nx) % ny, k = Math.floor(idx / (nx * ny));
      const p = [i, j, k];
      for (let a = 0; a < 3; a++) {
        if (fixed(a)) continue;
        for (const d of [-1, 1]) {
          const q = p[a] + d;
          if (q < lo[a] || q > hi[a]) continue;
          const nb = idx + d * stride[a];
          if (!seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        }
      }
    }
    if (!region.length) return region;
    const m = rs / region.length;
    const sd = Math.sqrt(Math.max(0, rsq / region.length - m * m));
    if (Math.abs(m - mean) < 1e-6 && Math.abs(sd - std) < 1e-6) break;
    mean = m;
    std = sd;
  }
  return region;
}
