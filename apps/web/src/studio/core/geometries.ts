import type { GeometryContribution, Space } from "@studio/plugin-ui-sdk/module";
import type { Annotation, Geometry } from "@studio/contracts/types";

/** Core geometries: domain-neutral shapes every module can create, plus their one-line descriptions. */

const fmt = (n: number, d = 2) => n.toFixed(d);
const at = (g: { frame?: number; slice?: number; plane?: string }) =>
  `${g.plane ? ` · ${g.plane}` : ""}${g.slice !== undefined ? ` · slice ${g.slice + 1}` : ""}${g.frame !== undefined ? ` · frame ${g.frame + 1}` : ""}`;
const channel = (c: string | undefined) => (c === undefined ? "" : c === "all" ? " · all channels" : ` · ${c}`);

type Of<T extends string> = Extract<Geometry, { type: T }>;
function geometry<T extends Geometry["type"]>(
  type: T,
  description: string,
  describe: (g: Of<T & string>, a: Annotation) => string,
  spaces?: Space[],
): GeometryContribution {
  return { id: type.replace(/[^a-z0-9]/gi, ""), type, description, spaces, describe: describe as GeometryContribution["describe"] };
}

const PLANAR: Space[] = ["image2d", "volume"];

export const coreGeometries: GeometryContribution[] = [
  geometry("class", "Item-level class (whole image, recording or study)", () => "Image label"),
  geometry("box", "Axis-aligned rectangle in item pixels", (g) => `Box ${Math.round(g.w)}×${Math.round(g.h)}px${at(g)}`, PLANAR),
  geometry("ellipse", "Ellipse in item pixels", (g) => `Ellipse ${Math.round(g.rx * 2)}×${Math.round(g.ry * 2)}px${at(g)}`, PLANAR),
  geometry("polygon", "Closed contour, optionally with holes", (g) => `Polygon · ${g.points.length} pts${g.holes?.length ? ` · ${g.holes.length} holes` : ""}${at(g)}`, PLANAR),
  geometry("multipolygon", "Several disjoint regions with holes", (g) => `Region · ${g.polygons.length} parts${at(g)}`, PLANAR),
  geometry("polyline", "Open line through points", (g) => `Polyline · ${g.points.length} pts${at(g)}`, PLANAR),
  geometry("spline", "Smooth closed contour through control points", (g) => `Spline contour · ${g.points.length} control pts${at(g)}`, PLANAR),
  geometry("keypoint", "Single 2D location (landmark, cell)", (g) => `Keypoint · ${Math.round(g.x)}, ${Math.round(g.y)}${at(g)}`, PLANAR),
  geometry("point3d", "3D landmark in voxel indices", (g) => `Point · ${g.plane} ${g.slice + 1}`, ["volume"]),
  geometry("measurement", "Measurement or ROI with computed stats (length, angle, area…)", (g) => {
    const main = g.stats && Object.entries(g.stats)[0];
    return `${g.kind.replace(/-/g, " ")}${main ? ` · ${fmt(main[1])}${g.unit ? ` ${g.unit}` : ""}` : ""}${at(g)}`;
  }, PLANAR),
  geometry("mask", "Run-length encoded pixel / voxel mask", (g) =>
    `Mask${g.volumeMm3 !== undefined ? ` · ${fmt(g.volumeMm3 / 1000)} mL` : g.voxels !== undefined ? ` · ${g.voxels.toLocaleString()} px` : ""}${at(g)}`, PLANAR),
  geometry("span", "Span on a time axis (seconds), optionally on one channel", (g) => `Span ${fmt(g.start)}–${fmt(g.end)}s${channel(g.channel)}`),
  geometry("instant", "Point in time (seconds or frame), optionally on one channel", (g) =>
    g.frame !== undefined ? `Event · frame ${g.frame + 1}${channel(g.channel)}` : `Instant · ${fmt(g.t ?? 0, 3)}s${channel(g.channel)}`),
  geometry("track", "Object tracked across frames by keyframes", (g) => {
    const frames = g.keyframes.map((k) => k.frame);
    return `Track (${g.shape}) · ${g.keyframes.length} keyframes · frames ${Math.min(...frames) + 1}–${Math.max(...frames) + 1}`;
  }),
];

/**
 * v1 geometries, kept describable until every module produces core ones
 * (migrations/annotations-v1-to-v2.ts).
 */
export const legacyGeometries: GeometryContribution[] = [
  geometry("mark", "Deprecated: use keypoint", (g) => `Point · ${Math.round(g.x)}, ${Math.round(g.y)}`),
  geometry("point", "Deprecated: use point3d", (g) => `Point · ${g.plane} ${g.slice + 1}`),
  geometry("interval", "Deprecated: use span with channel", (g) => `${g.lead === "all" ? "All leads" : g.lead} · ${fmt(g.start)}–${fmt(g.end)}s`),
  geometry("beat", "Deprecated: use instant with attributes.code", (g) => `Beat ${g.code} · ${fmt(g.t, 3)}s${g.lead === "all" ? "" : ` · ${g.lead}`}`),
  geometry("wave", "Deprecated: use span with attributes.wave", (g) => `${g.wave} wave · ${g.lead} · ${fmt(g.onset, 3)}–${fmt(g.offset, 3)}s`),
  geometry("rhythm", "Deprecated: use span with attributes.rhythm", (g) => `Rhythm ${g.rhythm} · ${fmt(g.start)}–${fmt(g.end)}s`),
  geometry("segment", "Deprecated: use span", (g) => `Span ${fmt(g.start)}–${fmt(g.end)}s`),
  geometry("event", "Deprecated: use instant", (g) => `Event · frame ${g.frame + 1}`),
  geometry("phase", "Deprecated: use instant with attributes.phase", (g) => `${g.phase === "ED" ? "End-diastole" : "End-systole"} · frame ${g.frame + 1}`),
];
