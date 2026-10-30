import type { Annotation, Geometry, Pt, TrackKeyframe } from "@studio/plugin-contracts/types";
import { interpolateRings } from "@studio/studio-renderers/overlay2d/geometry";

/**
 * Object tracks (CVAT "track mode"). A track stores keyframes only; the shape on any
 * other frame is interpolated. Semantics follow CVAT so exports round-trip:
 * - nothing exists before the first keyframe;
 * - an `outside` keyframe hides the object until the next keyframe;
 * - after the last (visible) keyframe the shape holds to the end of the video;
 * - `occluded` is a property of the span that starts at a keyframe.
 */

export type TrackGeometry = Extract<Geometry, { type: "track" }>;
export type ShapeKind = TrackGeometry["shape"];
export type Box = [number, number, number, number];

/** A shape as it appears on one frame, in video pixels. */
export interface FrameShape {
  kind: ShapeKind;
  box?: Box;
  points?: Pt[];
  occluded: boolean;
  /** Stored on this frame (a track keyframe, or a per-frame shape) rather than interpolated. */
  keyframe: boolean;
}

export function sortKeyframes(kfs: TrackKeyframe[]): TrackKeyframe[] {
  return [...kfs].sort((a, b) => a.frame - b.frame);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Last keyframe at or before `frame` that carries shape data (outside keyframes may too). */
function shapeSource(kfs: TrackKeyframe[], frame: number, kind: ShapeKind): TrackKeyframe | undefined {
  const has = (k: TrackKeyframe) => (kind === "box" ? !!k.box : !!k.points?.length);
  let found: TrackKeyframe | undefined;
  for (const k of kfs) {
    if (k.frame > frame) break;
    if (has(k)) found = k;
  }
  return found ?? kfs.find(has);
}

function interpolatePoints(a: Pt[], b: Pt[], t: number, closed: boolean): Pt[] {
  if (a.length === b.length) return a.map((p, i) => [lerp(p[0], b[i][0], t), lerp(p[1], b[i][1], t)]);
  if (!closed) return a.map((p) => [p[0], p[1]]);
  return interpolateRings(a, b, t, Math.max(a.length, b.length));
}

/** The (possibly interpolated) shape of a track on `frame`, or null when it isn't on screen. */
export function shapeAt(g: TrackGeometry, frame: number): FrameShape | null {
  const kfs = sortKeyframes(g.keyframes);
  if (!kfs.length || frame < kfs[0].frame) return null;
  let i = 0;
  while (i + 1 < kfs.length && kfs[i + 1].frame <= frame) i++;
  const prev = kfs[i];
  if (prev.outside) return null;
  const src = shapeSource(kfs, prev.frame, g.shape);
  if (!src) return null;
  const occluded = !!prev.occluded;
  const base: FrameShape = { kind: g.shape, occluded, keyframe: prev.frame === frame };
  const next = kfs[i + 1];
  const hold = prev.frame === frame || !next || next.outside;
  if (g.shape === "box") {
    const a = src.box!;
    if (hold || !next.box) return { ...base, box: [...a] as Box };
    const t = (frame - prev.frame) / (next.frame - prev.frame);
    const b = next.box;
    return { ...base, box: [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)] };
  }
  const a = src.points!;
  if (hold || !next.points?.length) return { ...base, points: a.map((p) => [p[0], p[1]] as Pt) };
  const t = (frame - prev.frame) / (next.frame - prev.frame);
  return { ...base, points: interpolatePoints(a, next.points, t, g.shape === "polygon") };
}

/** Shape data to seed a new keyframe on `frame`: the interpolated shape, else the last known one. */
function seedShape(g: TrackGeometry, frame: number): Pick<TrackKeyframe, "box" | "points"> {
  const s = shapeAt(g, frame);
  if (s) return s.box ? { box: s.box } : { points: s.points };
  const src = shapeSource(sortKeyframes(g.keyframes), frame, g.shape);
  if (!src) return {};
  return src.box ? { box: [...src.box] as Box } : { points: src.points?.map((p) => [p[0], p[1]] as Pt) };
}

/** Insert or update the keyframe on `frame`, seeding it from the current interpolated state. */
export function withKeyframe(g: TrackGeometry, frame: number, patch: Partial<Omit<TrackKeyframe, "frame">>): TrackGeometry {
  const kfs = sortKeyframes(g.keyframes);
  const at = kfs.findIndex((k) => k.frame === frame);
  if (at >= 0) {
    kfs[at] = clean({ ...kfs[at], ...patch, frame });
  } else {
    const s = shapeAt(g, frame);
    const seeded: TrackKeyframe = { frame, ...seedShape(g, frame), occluded: s?.occluded, outside: s ? undefined : frame >= (kfs[0]?.frame ?? 0) };
    kfs.push(clean({ ...seeded, ...patch, frame }));
  }
  return { ...g, keyframes: sortKeyframes(kfs) };
}

function clean(k: TrackKeyframe): TrackKeyframe {
  const out: TrackKeyframe = { frame: k.frame };
  if (k.outside) out.outside = true;
  if (k.occluded) out.occluded = true;
  if (k.box) out.box = k.box.map((v) => round2(v)) as Box;
  if (k.points) out.points = k.points.map(([x, y]) => [round2(x), round2(y)]);
  return out;
}

export const round2 = (v: number) => Math.round(v * 100) / 100;

export function keyframeAt(g: TrackGeometry, frame: number): TrackKeyframe | undefined {
  return g.keyframes.find((k) => k.frame === frame);
}

/** Add a keyframe holding the current shape, or remove the one on this frame (never the last one). */
export function toggleKeyframe(g: TrackGeometry, frame: number): TrackGeometry {
  if (keyframeAt(g, frame)) {
    if (g.keyframes.length <= 1) return g;
    return { ...g, keyframes: g.keyframes.filter((k) => k.frame !== frame) };
  }
  return withKeyframe(g, frame, {});
}

export function toggleOutside(g: TrackGeometry, frame: number): TrackGeometry {
  const visible = !!shapeAt(g, frame);
  return withKeyframe(g, frame, visible ? { outside: true } : { outside: false, ...seedShape(g, frame) });
}

export function toggleOccluded(g: TrackGeometry, frame: number): TrackGeometry {
  const s = shapeAt(g, frame);
  if (!s) return g;
  return withKeyframe(g, frame, { occluded: !s.occluded });
}

/** Move the keyframe on `from` to `to` (ignored if `to` already holds one). */
export function moveKeyframe(g: TrackGeometry, from: number, to: number): TrackGeometry {
  if (from === to || keyframeAt(g, to)) return g;
  return { ...g, keyframes: sortKeyframes(g.keyframes.map((k) => (k.frame === from ? { ...k, frame: to } : k))) };
}

/** Visible spans [start, end) of a track; `end` is clamped to `total` frames. */
export function trackSpans(g: TrackGeometry, total: number): { start: number; end: number; occluded: boolean }[] {
  const kfs = sortKeyframes(g.keyframes);
  const out: { start: number; end: number; occluded: boolean }[] = [];
  kfs.forEach((k, i) => {
    if (k.outside) return;
    const end = Math.min(total, kfs[i + 1]?.frame ?? total);
    if (end <= k.frame) return;
    const last = out[out.length - 1];
    if (last && last.end === k.frame && last.occluded === !!k.occluded) last.end = end;
    else out.push({ start: k.frame, end, occluded: !!k.occluded });
  });
  return out;
}

export function visibleFrameCount(g: TrackGeometry, total: number): number {
  return trackSpans(g, total).reduce((n, s) => n + s.end - s.start, 0);
}

/** Shape of any video annotation on `frame` (tracks interpolated; per-frame shapes only on their frame). */
export function shapeOnFrame(g: Geometry, frame: number): FrameShape | null {
  const on = (f?: number) => f === undefined || f === frame;
  switch (g.type) {
    case "track":
      return shapeAt(g, frame);
    case "box":
      return on(g.frame) ? { kind: "box", box: [g.x, g.y, g.w, g.h], occluded: false, keyframe: true } : null;
    case "polygon":
      return on(g.frame) ? { kind: "polygon", points: g.points, occluded: false, keyframe: true } : null;
    case "keypoint":
      return on(g.frame) ? { kind: "keypoint", points: [[g.x, g.y]], occluded: false, keyframe: true } : null;
    default:
      return null;
  }
}

/** Geometry with `shape` written back: a keyframe on `frame` for tracks, in place for per-frame shapes. */
export function applyShape(g: Geometry, frame: number, s: { box?: Box; points?: Pt[] }): Geometry {
  switch (g.type) {
    case "track":
      return withKeyframe(g, frame, s.box ? { box: s.box } : { points: s.points });
    case "box": {
      const [x, y, w, h] = s.box!;
      return { ...g, x: round2(x), y: round2(y), w: round2(w), h: round2(h) };
    }
    case "polygon":
      return { ...g, points: s.points!.map(([x, y]) => [round2(x), round2(y)] as Pt) };
    case "keypoint":
      return { ...g, x: round2(s.points![0][0]), y: round2(s.points![0][1]) };
    default:
      return g;
  }
}

export function isSpatial(g: Geometry): boolean {
  return g.type === "track" || g.type === "box" || g.type === "polygon" || g.type === "keypoint";
}

/**
 * Stable, human-friendly track numbers (#1, #2…) per item. Uses `attributes.trackId` when
 * present and numbers the rest after the highest stored id, in creation order.
 */
export function trackNumbers(annotations: Annotation[]): Map<string, number> {
  const out = new Map<string, number>();
  let max = 0;
  for (const a of annotations) {
    const id = a.attributes?.trackId;
    if (a.geometry.type === "track" && typeof id === "number") {
      out.set(a.id, id);
      max = Math.max(max, id);
    }
  }
  for (const a of [...annotations].sort((x, y) => x.createdAt.localeCompare(y.createdAt))) {
    if (a.geometry.type === "track" && !out.has(a.id)) out.set(a.id, ++max);
  }
  return out;
}

export function nextTrackId(annotations: Annotation[], itemId: string): number {
  const mine = annotations.filter((a) => a.itemId === itemId);
  return Math.max(0, ...trackNumbers(mine).values()) + 1;
}

export function boxOfPoints(pts: Pt[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

/** A frame shape as the core geometry ShapeUtils understand (box / polygon / keypoint). */
export function frameGeometry(s: Pick<FrameShape, "kind" | "box" | "points">): Geometry {
  if (s.kind === "box") {
    const [x, y, w, h] = s.box!;
    return { type: "box", x, y, w, h };
  }
  if (s.kind === "polygon") return { type: "polygon", points: s.points! };
  return { type: "keypoint", x: s.points![0][0], y: s.points![0][1] };
}

/** Inverse of `frameGeometry`: the shape data `applyShape` writes back. */
export function shapeData(g: Geometry): { box?: Box; points?: Pt[] } {
  switch (g.type) {
    case "box":
      return { box: [g.x, g.y, g.w, g.h] };
    case "polygon":
      return { points: g.points };
    case "keypoint":
      return { points: [[g.x, g.y]] };
    default:
      return {};
  }
}
