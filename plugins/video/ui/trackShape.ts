import { registerShapeUtil, shapeUtil, type BBox, type ShapeUtil } from "@studio/studio-renderers/overlay2d/shapes";
import type { Geometry } from "@studio/plugin-contracts/types";
import { applyShape, frameGeometry, shapeAt, shapeData, type TrackGeometry } from "./tracks";

/**
 * ShapeUtil for `track` geometries, resolving the shape at the playhead. A track is placed
 * on a frame (`at`, the frame the renderer shows); every operation acts on the
 * (interpolated) shape there and writes back as a keyframe on that frame, so the 2D
 * editing code treats tracks like any other shape.
 */
export type PlacedTrack = TrackGeometry & { at: number };

export const placeTrack = (g: TrackGeometry, frame: number): PlacedTrack => ({ ...g, at: frame });

/** Drop the placement before storing a geometry. */
export function unplace(g: Geometry): Geometry {
  if (g.type !== "track" || !("at" in g)) return g;
  const { at: _at, ...rest } = g as PlacedTrack;
  return rest;
}

const frameOf = (g: TrackGeometry) => (g as Partial<PlacedTrack>).at ?? Math.min(...g.keyframes.map((k) => k.frame));

/** The core geometry (box / polygon / keypoint) a placed track shows on its frame; null when outside. */
export function resolveTrack(g: TrackGeometry): Geometry | null {
  const s = shapeAt(g, frameOf(g));
  return s ? frameGeometry(s) : null;
}

function write(g: TrackGeometry, fn: (shape: Geometry, util: ShapeUtil) => Geometry): TrackGeometry {
  const shape = resolveTrack(g);
  if (!shape) return g;
  const at = frameOf(g);
  return { ...(applyShape(g, at, shapeData(fn(shape, shapeUtil(shape)!))) as TrackGeometry), at } as PlacedTrack;
}

const NONE: BBox = [0, 0, 0, 0];

export const trackShapeUtil: ShapeUtil<TrackGeometry> = {
  type: "track",
  closed: true,
  bounds: (g) => {
    const s = resolveTrack(g);
    return s ? shapeUtil(s)!.bounds(s) : NONE;
  },
  handles: (g) => {
    const s = resolveTrack(g);
    return s ? shapeUtil(s)!.handles(s) : [];
  },
  applyHandle: (g, index, p) => write(g, (s, u) => u.applyHandle(s, index, p)),
  translate: (g, dx, dy) => write(g, (s, u) => u.translate(s, dx, dy)),
  hitTest: (g, p, toScreen, opts) => {
    const s = resolveTrack(g);
    return s ? shapeUtil(s)!.hitTest(s, p, toScreen, opts) : null;
  },
  path: (g, toScreen) => {
    const s = resolveTrack(g);
    return s ? shapeUtil(s)!.path(s, toScreen) : new Path2D();
  },
};

let registered = false;
/** Make `shapeUtil(track)` resolve through this wrapper (idempotent; done when the module loads). */
export function registerTrackShape(): void {
  if (registered) return;
  registered = true;
  registerShapeUtil(trackShapeUtil as unknown as ShapeUtil);
}
