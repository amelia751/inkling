import type { Annotation, Geometry } from "@studio/plugin-contracts/types";
import { applyShape, nextTrackId, round2, shapeAt, shapeData, type Box, type TrackGeometry } from "../tracks";
import type { DrawKind } from "./FrameEditor";
import { isEditable, newAnnotation, useHost } from "@studio/plugin-ui-sdk";

/**
 * Store edits the video renderer performs: creating shapes, tracks, spans and instants on
 * a frame, keyframe operations on the selection and copy-to-next-frame. Each is one undo step.
 */

const st = () => useHost.getState();
export const editable = (a: Annotation) => isEditable(a, st().lockedLabels);
export const labelUsable = (l: string | null): l is string => !!l && !st().lockedLabels.includes(l);

function addSelected(itemId: string, label: string, geometry: Geometry, attributes?: Annotation["attributes"]) {
  const a = newAnnotation({ itemId, label, geometry, attributes });
  st().add(a);
  st().select(a.id);
}

/** A drawn shape: a one-keyframe track, or (per-frame mode) a shape placed on `frame`. */
export function createShape(itemId: string, frame: number, perFrame: boolean, kind: DrawKind, shape: Geometry) {
  const label = st().activeLabel;
  if (!labelUsable(label)) return;
  const data = shapeData(shape);
  let geometry: Geometry;
  let attributes: Annotation["attributes"];
  if (perFrame) geometry = { ...(applyShape(shape, frame, data) as Extract<Geometry, { type: DrawKind }>), frame };
  else {
    const kf = data.box ? { box: data.box.map(round2) as Box } : { points: data.points!.map(([x, y]) => [round2(x), round2(y)] as [number, number]) };
    geometry = { type: "track", shape: kind, keyframes: [{ frame, ...kf }] };
    attributes = { trackId: nextTrackId(st().annotations, itemId) };
  }
  addSelected(itemId, label, geometry, attributes);
}

/** An event (instant) at `frame`, with the active label. */
export function addInstant(itemId: string, frame: number): boolean {
  const label = st().activeLabel;
  if (!labelUsable(label)) return false;
  addSelected(itemId, label, { type: "instant", frame });
  return true;
}

/** A span in seconds with `label`. */
export function addSpan(itemId: string, label: string, start: number, end: number) {
  if (labelUsable(label)) addSelected(itemId, label, { type: "span", start: +start.toFixed(4), end: +end.toFixed(4) });
}

/** Replace a geometry if its annotation is still editable. */
export function setGeometry(id: string, g: Geometry) {
  const a = st().annotations.find((x) => x.id === id);
  if (a && editable(a)) st().update(id, { geometry: g });
}

/** Selected annotations of this item (primary last), as currently stored. */
function selection(itemId: string) {
  const s = st();
  const ids = new Set(s.selectedIds.length ? s.selectedIds : s.selectedId ? [s.selectedId] : []);
  return s.annotations.filter((a) => ids.has(a.id) && a.itemId === itemId);
}

/** Apply a keyframe operation to every selected, editable track on `frame` (one undo step). False when no track is selected. */
export function editTracks(itemId: string, frame: number, fn: (g: TrackGeometry, f: number) => TrackGeometry): boolean {
  const tracks = selection(itemId).filter((a): a is Annotation & { geometry: TrackGeometry } => a.geometry.type === "track" && editable(a));
  if (!tracks.length) return false;
  const updates = tracks.flatMap((a) => {
    const g = fn(a.geometry, frame);
    return g !== a.geometry ? [{ id: a.id, patch: { geometry: g as Geometry } }] : [];
  });
  if (updates.length === 1) st().update(updates[0].id, updates[0].patch);
  else if (updates.length) st().batch({ update: updates });
  return true;
}

/** Previous / next keyframe of the selected track, or of anything on the timeline when no track is selected. */
export function keyframeTarget(mine: Annotation[], selectedTrack: TrackGeometry | null, fps: number, cur: number, dir: -1 | 1): number | undefined {
  const marks = selectedTrack
    ? selectedTrack.keyframes.map((k) => k.frame)
    : mine.flatMap((a) => {
        const g = a.geometry;
        if (g.type === "track") return g.keyframes.map((k) => k.frame);
        if (g.type === "instant") return [g.frame ?? Math.round((g.t ?? 0) * fps)];
        if (g.type === "span") return [Math.round(g.start * fps)];
        const frame = (g as { frame?: number }).frame;
        return typeof frame === "number" ? [frame] : [];
      });
  const sorted = [...new Set(marks)].sort((a, b) => a - b);
  return dir > 0 ? sorted.find((f) => f > cur) : sorted.reverse().find((f) => f < cur);
}

/** Copy every selected shape onto the next frame (a keyframe for tracks). Returns the frame to show, or null. */
export function copyToNextFrame(itemId: string, frame: number, frames: number): number | null {
  if (frame + 1 >= frames) return null;
  const updates: { id: string; patch: { geometry: Geometry } }[] = [];
  const copies: Annotation[] = [];
  for (const a of selection(itemId)) {
    const g = a.geometry;
    if (!editable(a)) continue;
    if (g.type === "track") {
      const shape = shapeAt(g, frame);
      if (shape) updates.push({ id: a.id, patch: { geometry: applyShape(g, frame + 1, { box: shape.box, points: shape.points }) } });
    } else if ((g.type === "box" || g.type === "polygon" || g.type === "keypoint") && g.frame === frame) {
      copies.push(newAnnotation({ itemId, label: a.label, geometry: { ...g, frame: frame + 1 }, attributes: a.attributes }));
    }
  }
  if (!updates.length && !copies.length) return null;
  if (updates.length + copies.length === 1 && updates.length) st().update(updates[0].id, updates[0].patch);
  else st().batch({ update: updates, upsert: copies });
  // Per-frame copies become the selection on the new frame; tracks stay selected.
  if (copies.length) st().selectMany([...updates.map((u) => u.id), ...copies.map((c) => c.id)]);
  return frame + 1;
}
