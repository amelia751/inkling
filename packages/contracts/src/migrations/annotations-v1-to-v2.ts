import type { Annotation, AnnotationDocument, Geometry } from "../types";

/**
 * Annotations v1 → v2: medical geometries become core, domain-neutral ones, with their
 * vocabulary moved into `attributes` (todo phase 2):
 *
 *   interval → span     { channel: lead }
 *   beat     → instant  { t, channel: lead }            attributes.code
 *   wave     → span     { channel: lead }               attributes.wave, attributes.peak
 *   rhythm   → span     { channel: "rhythm" }           attributes.rhythm
 *   phase    → instant  { frame }                       attributes.phase
 *   segment  → span
 *   event    → instant  { frame }
 *   mark     → keypoint
 *   point    → point3d
 *
 * `migrate` is pure and idempotent: v2 geometries pass through untouched, so a mixed
 * document (some items edited after the upgrade) is fine. `kind` records the v1 type in
 * `attributes.kind` so modules can tell a wave from an interval without guessing.
 */
export const ANNOTATIONS_VERSION = 2;

type Attrs = NonNullable<Annotation["attributes"]>;
type V1 = Extract<Geometry, { type: "interval" | "beat" | "wave" | "rhythm" | "phase" | "segment" | "event" | "mark" | "point" }>;

function convert(g: V1): { geometry: Geometry; attributes?: Attrs } {
  switch (g.type) {
    case "interval":
      return { geometry: { type: "span", start: g.start, end: g.end, channel: g.lead }, attributes: { kind: "interval" } };
    case "beat":
      return { geometry: { type: "instant", t: g.t, channel: g.lead }, attributes: { kind: "beat", code: g.code } };
    case "wave":
      return {
        geometry: { type: "span", start: g.onset, end: g.offset, channel: g.lead },
        attributes: { kind: "wave", wave: g.wave, ...(g.peak !== undefined ? { peak: g.peak } : {}) },
      };
    case "rhythm":
      return { geometry: { type: "span", start: g.start, end: g.end, channel: "rhythm" }, attributes: { kind: "rhythm", rhythm: g.rhythm } };
    case "phase":
      return { geometry: { type: "instant", frame: g.frame }, attributes: { kind: "phase", phase: g.phase } };
    case "segment":
      return { geometry: { type: "span", start: g.start, end: g.end } };
    case "event":
      return { geometry: { type: "instant", frame: g.frame } };
    case "mark":
      return { geometry: { type: "keypoint", x: g.x, y: g.y } };
    case "point":
      return { geometry: { type: "point3d", plane: g.plane, slice: g.slice, ijk: g.ijk } };
  }
}

const V1_TYPES = new Set(["interval", "beat", "wave", "rhythm", "phase", "segment", "event", "mark", "point"]);

export function migrateAnnotation(a: Annotation, only?: Set<string>): Annotation {
  if (!V1_TYPES.has(a.geometry.type) || (only && !only.has(a.geometry.type))) return a;
  const { geometry, attributes } = convert(a.geometry as V1);
  return { ...a, geometry, attributes: attributes ? { ...a.attributes, ...attributes } : a.attributes };
}

/**
 * Rewrite a stored document. `only` limits the rewrite to some v1 types: modules are
 * converted one at a time, and a v1 type stays as-is until its module reads v2.
 */
export function migrateDocument(doc: AnnotationDocument, only?: Set<string>): AnnotationDocument {
  const annotations = doc.annotations.map((a) => migrateAnnotation(a, only));
  const done = !annotations.some((a) => V1_TYPES.has(a.geometry.type));
  return { ...doc, annotations, annotationsVersion: done ? ANNOTATIONS_VERSION : doc.annotationsVersion };
}
