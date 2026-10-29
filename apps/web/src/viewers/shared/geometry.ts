import simplifyPath from "simplify-js";
import type { Pt } from "@/types";

/** Signed shoelace area; positive for counter-clockwise rings in a y-down space is negative, so use |area|. */
export function signedArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return s / 2;
}

/** Polygon area in squared input units, holes subtracted. Scale by (dx·dy) for physical units. */
export function polygonArea(outer: Pt[], holes: Pt[][] = []): number {
  return Math.abs(signedArea(outer)) - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
}

export function pathLength(pts: Pt[], closed = false, sx = 1, sy = 1): number {
  let len = 0;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    len += Math.hypot((bx - ax) * sx, (by - ay) * sy);
  }
  return len;
}

export function centroid(pts: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

export function bounds(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function pointInPolygon([x, y]: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from p to segment ab, and the parameter t ∈ [0,1] of the closest point. */
export function distToSegment(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return { d: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t };
}

/** Index of the vertex within `radius` of p, or -1. */
export function hitVertex(p: Pt, pts: Pt[], radius: number): number {
  let best = -1, bestD = radius;
  pts.forEach((v, i) => {
    const d = Math.hypot(v[0] - p[0], v[1] - p[1]);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Edge (i → i+1) within `radius` of p; returns the index to insert a new vertex at, or -1. */
export function hitEdge(p: Pt, pts: Pt[], radius: number, closed = true): number {
  let best = -1, bestD = radius;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const { d } = distToSegment(p, pts[i], pts[(i + 1) % pts.length]);
    if (d <= bestD) {
      bestD = d;
      best = i + 1;
    }
  }
  return best;
}

/** Ramer–Douglas–Peucker simplification (tolerance in input units). */
export function simplify(pts: Pt[], tolerance: number): Pt[] {
  return simplifyPath(pts.map(([x, y]) => ({ x, y })), tolerance, true).map((p) => [p.x, p.y] as Pt);
}

/**
 * Densely sample a closed centripetal Catmull-Rom spline (α = 0.5) through the control
 * points. Centripetal parameterisation avoids cusps and self-intersections when points
 * bunch up, which matters for cardiac contours edited by hand.
 */
export function catmullRomClosed(ctrl: Pt[], samplesPerSegment = 12): Pt[] {
  const n = ctrl.length;
  if (n < 3) return ctrl.slice();
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    const knot = (a: Pt, b: Pt) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = t1 + ((t2 - t1) * s) / samplesPerSegment;
      const lerp = (a: Pt, b: Pt, ta: number, tb: number): Pt => {
        const w = (t - ta) / (tb - ta);
        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      };
      const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  return out;
}

/** Resample a ring (closed) or path to exactly n points evenly spaced by arc length. */
export function resample(pts: Pt[], n: number, closed = true): Pt[] {
  if (pts.length < 2) return Array.from({ length: n }, () => (pts[0] ?? [0, 0]).slice() as Pt);
  const ring = closed ? [...pts, pts[0]] : pts;
  const cum = [0];
  for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]));
  const total = cum[cum.length - 1] || 1;
  const out: Pt[] = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (closed ? n : n - 1);
    while (j < ring.length - 1 && cum[j] < target) j++;
    const seg = cum[j] - cum[j - 1] || 1;
    const w = (target - cum[j - 1]) / seg;
    out.push([ring[j - 1][0] + (ring[j][0] - ring[j - 1][0]) * w, ring[j - 1][1] + (ring[j][1] - ring[j - 1][1]) * w]);
  }
  return out;
}

/**
 * Shape-interpolate two closed contours: resample both to N points, rotate b's start
 * to minimise total vertex distance (and match winding), then blend. t=0 → a, t=1 → b.
 */
export function interpolateRings(a: Pt[], b: Pt[], t: number, n = 64): Pt[] {
  const ra = resample(a, n);
  let rb = resample(b, n);
  if (Math.sign(signedArea(ra)) !== Math.sign(signedArea(rb))) rb = rb.reverse();
  let bestShift = 0, bestCost = Infinity;
  for (let s = 0; s < n; s++) {
    let cost = 0;
    for (let i = 0; i < n; i++) {
      const q = rb[(i + s) % n];
      cost += (ra[i][0] - q[0]) ** 2 + (ra[i][1] - q[1]) ** 2;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestShift = s;
    }
  }
  return ra.map(([x, y], i) => {
    const [qx, qy] = rb[(i + bestShift) % n];
    return [x + (qx - x) * t, y + (qy - y) * t];
  });
}

/** Points on an ellipse outline, for drawing and hit-testing. */
export function ellipsePoints(cx: number, cy: number, rx: number, ry: number, rotation = 0, n = 64): Pt[] {
  const c = Math.cos(rotation), s = Math.sin(rotation);
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const x = rx * Math.cos(a), y = ry * Math.sin(a);
    return [cx + x * c - y * s, cy + x * s + y * c] as Pt;
  });
}

// ---- Masks ----

/** Run-length encode a binary mask: alternating background/foreground run lengths, starting with background. */
export function rleEncode(mask: ArrayLike<number>, value?: number): number[] {
  const counts: number[] = [];
  let current = 0, run = 0;
  for (let i = 0; i < mask.length; i++) {
    const on = value === undefined ? (mask[i] ? 1 : 0) : mask[i] === value ? 1 : 0;
    if (on !== current) {
      counts.push(run);
      run = 0;
      current = on;
    }
    run++;
  }
  counts.push(run);
  return counts;
}

/** Decode into `out` (setting `value` where foreground), or a fresh Uint8Array of `length`. */
export function rleDecode(counts: number[], length: number, out?: Uint8Array | Uint16Array, value = 1): Uint8Array | Uint16Array {
  const dst = out ?? new Uint8Array(length);
  let i = 0;
  counts.forEach((run, k) => {
    if (k % 2 === 1) dst.fill(value, i, Math.min(length, i + run));
    i += run;
  });
  return dst;
}

export function rleForeground(counts: number[]): number {
  let n = 0;
  for (let k = 1; k < counts.length; k += 2) n += counts[k];
  return n;
}

/** Scanline-fill a polygon (with optional holes, even-odd rule) into a width×height mask. */
export function rasterizePolygon(rings: Pt[][], width: number, height: number, out = new Uint8Array(width * height), value = 1): Uint8Array {
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x0, y0] = ring[j], [x1, y1] = ring[i];
        if ((y0 <= cy && y1 > cy) || (y1 <= cy && y0 > cy)) xs.push(x0 + ((cy - y0) / (y1 - y0)) * (x1 - x0));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      if (to >= from) out.fill(value, y * width + from, y * width + to + 1);
    }
  }
  return out;
}
