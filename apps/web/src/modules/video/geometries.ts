import type { GeometryContribution } from "@/platform/module";
import type { Annotation, Geometry } from "@/types";

/**
 * How video annotations read in lists: core `span` / `instant` / `track` refined with video
 * vocabulary (segments, events, numbered tracks). Pure functions only (imported by the manifest).
 */
type Of<T extends Geometry["type"]> = Extract<Geometry, { type: T }>;

export const describeSpan = (g: Of<"span">) => `Segment ${g.start.toFixed(2)}–${g.end.toFixed(2)}s · ${(g.end - g.start).toFixed(2)} s`;

export const describeInstant = (g: Of<"instant">) => (g.frame !== undefined ? `Event · frame ${g.frame + 1}` : `Event · ${(g.t ?? 0).toFixed(3)}s`);

export function describeTrack(g: Of<"track">, a?: Annotation) {
  const frames = g.keyframes.map((k) => k.frame);
  const id = a?.attributes?.trackId;
  return `Track${typeof id === "number" ? ` #${id}` : ""} (${g.shape}) · ${g.keyframes.length} keyframes · frames ${Math.min(...frames) + 1}–${Math.max(...frames) + 1}`;
}

export const videoGeometries: GeometryContribution[] = [
  { id: "segment", type: "span", spaces: ["image2d"], description: "A labelled segment of the video (seconds); was v1 `segment`", describe: (g) => describeSpan(g as Of<"span">) },
  { id: "event", type: "instant", spaces: ["image2d"], description: "A point-in-time event on a frame; was v1 `event`", describe: (g) => describeInstant(g as Of<"instant">) },
  { id: "track", type: "track", spaces: ["image2d"], description: "Object track with keyframes, interpolated between them (CVAT track semantics)", describe: (g, a) => describeTrack(g as Of<"track">, a) },
];
