import * as z from "zod";
import type { Annotation, Geometry } from "./types";

/**
 * Annotation revisions for dataset versioning (versioning.md §3.3, todo4 Phase 2). This file
 * owns `schemas/versioning/annotation-revision.schema.json` (emitted by
 * `pnpm emit:schemas`); `apps/versioning` (Go) validates against the emitted file and
 * never defines the shape itself.
 *
 * A revision is immutable canonical JSON referenced by content hash. Its `kind` is a
 * coarse, domain-neutral family of Studio geometries, which is what the versioning
 * service diffs and merges generically (plugin-declared rules, `annotations.diff`, V13).
 */

export const REVISION_KINDS = ["box2d", "polygon2d", "mask2d", "region3d", "timespan", "measurement", "textspan"] as const;
export const RevisionKind = z.enum(REVISION_KINDS);
export type RevisionKind = z.infer<typeof RevisionKind>;

/** Ids and enum-like tokens (no free text: diffs and merges are redacted to ids and enums, spec §14). */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN = /^[a-z0-9][a-z0-9_.+/-]{0,127}$/;
export const RevisionId = z.string().regex(ID);
export const RevisionToken = z.string().regex(TOKEN);

export const RevisionGeometry = z
  .object({
    box: z.array(z.number()).length(4).describe("box2d: x, y, w, h").optional(),
    points: z.array(z.array(z.number()).min(2).max(3)).optional(),
    mask: z
      .object({
        size: z.array(z.int().min(1)).length(2),
        counts: z.array(z.int().min(0)),
      })
      .strict()
      .describe("Uncompressed column-major RLE; runs alternate background/foreground starting with background.")
      .optional(),
    box3d: z.array(z.number()).length(6).optional(),
    start: z.number().optional(),
    end: z.number().optional(),
    value: z.number().optional(),
    unit: z.string().optional(),
  })
  .strict();
export type RevisionGeometry = z.infer<typeof RevisionGeometry>;

/** Which geometry fields each kind must carry (emitted as `allOf` if/then rules). */
export const REQUIRED_GEOMETRY: Record<RevisionKind, (keyof RevisionGeometry)[]> = {
  box2d: ["box"],
  polygon2d: ["points"],
  mask2d: ["mask"],
  region3d: ["box3d"],
  timespan: ["start", "end"],
  textspan: ["start", "end"],
  measurement: ["points", "value"],
};

export const REVISION_STATUSES = ["draft", "submitted", "accepted", "rejected"] as const;

export const AnnotationRevision = z
  .object({
    schema_version: z.literal("1"),
    annotation_id: RevisionId,
    sample_id: RevisionId,
    kind: RevisionKind,
    class_id: RevisionId,
    ontology_rev: z.string(),
    geometry: RevisionGeometry,
    coordinate_frame: RevisionToken,
    calibration: z
      .object({ pixel_spacing: z.array(z.number()).optional(), slice_thickness: z.number().optional(), units: z.string().optional() })
      .strict()
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
    status: z.enum(REVISION_STATUSES),
    reviewer_id: z.string().optional(),
    attributes: z.record(z.string(), RevisionToken).optional(),
    provenance: z.object({ actor_id: z.string(), tool: z.string().optional(), parent_revision: z.string().optional() }).strict(),
  })
  .strict()
  .superRefine((r, ctx) => {
    for (const f of REQUIRED_GEOMETRY[r.kind]) if (r.geometry[f] === undefined) ctx.addIssue({ code: "custom", path: ["geometry", f], message: `${r.kind} needs geometry.${f}` });
  });
export type AnnotationRevision = z.infer<typeof AnnotationRevision>;

/** The JSON Schema written to schemas/versioning/annotation-revision.schema.json. */
export function annotationRevisionJsonSchema(): Record<string, unknown> {
  const base = z.toJSONSchema(AnnotationRevision, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "annotation-revision.schema.json",
    title: "AnnotationRevision",
    description:
      "Immutable annotation revision (versioning.md §3.3, todo4 2.1), stored as canonical JSON and referenced by content hash. Generated from packages/plugin-contracts/src/annotation-revision.ts by `pnpm emit:schemas`; do not edit.",
    ...Object.fromEntries(Object.entries(base).filter(([k]) => k !== "$schema")),
    allOf: groupRequired().map(([kinds, fields]) => ({
      if: { properties: { kind: kinds.length === 1 ? { const: kinds[0] } : { enum: kinds } } },
      then: { properties: { geometry: { required: fields } } },
    })),
  };
}

/** Kinds with the same required fields share one rule (timespan and textspan). */
function groupRequired(): [RevisionKind[], string[]][] {
  const out: [RevisionKind[], string[]][] = [];
  for (const k of REVISION_KINDS) {
    const fields = REQUIRED_GEOMETRY[k];
    const same = out.find(([, f]) => f.join() === fields.join());
    if (same) same[0].push(k);
    else out.push([[k], [...fields]]);
  }
  return out;
}

// ---- Studio annotation → revision ------------------------------------------------------------

/**
 * The kind of each core geometry, or `null` when versioning v1 can't represent it
 * (`class`, `track`, `ellipse`; legacy v1 geometries migrate to core ones first). Module
 * geometries (`<module>.<name>`) are mapped by their owning plugin through `moduleKinds`.
 */
export const GEOMETRY_KINDS: Record<string, RevisionKind | null> = {
  box: "box2d",
  polygon: "polygon2d",
  polyline: "polygon2d",
  spline: "polygon2d",
  keypoint: "polygon2d",
  multipolygon: null,
  ellipse: null,
  mask: "mask2d", // 3D masks (dims [w, h, d]) become region3d with their voxel box
  point3d: "region3d",
  measurement: "measurement",
  span: "timespan",
  instant: "timespan",
  class: null,
  track: null,
};

export interface RevisionContext {
  sampleId: string;
  ontologyRev: string;
  /** Map a Studio label to its ontology class id (default: the label itself). */
  classId?: (label: string) => string;
  /** `<module>.<name>` geometry type → kind, e.g. `{ [SPAN]: "textspan" }` for text spans. */
  moduleKinds?: Record<string, RevisionKind>;
  coordinateFrame?: string;
  parentRevision?: string;
}

const STATUS: Record<string, AnnotationRevision["status"]> = { accepted: "accepted", rejected: "rejected", pending: "submitted", edited: "submitted" };

/** Column-major RLE ([h, w]) of a 2D Studio mask (row-major runs over dims [w, h]). */
function toColumnMajor(dims: number[], counts: number[]): { size: number[]; counts: number[] } {
  const [w, h] = dims;
  const bits = new Uint8Array(w * h);
  let i = 0;
  counts.forEach((run, k) => {
    if (k % 2) bits.fill(1, i, i + run);
    i += run;
  });
  const out: number[] = [];
  let v = 0;
  let run = 0;
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      const b = bits[y * w + x];
      if (b !== v) {
        out.push(run);
        run = 0;
        v = b;
      }
      run++;
    }
  out.push(run);
  return { size: [h, w], counts: out };
}

/** Voxel bounding box [i0, j0, k0, i1, j1, k1] (half-open) of a 3D Studio mask, or null if empty. */
function maskBox3d(dims: number[], counts: number[]): number[] | null {
  const [w, h] = dims;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-1, -1, -1];
  const see = (x: number, y: number, z: number) => [x, y, z].forEach((c, d) => ((lo[d] = Math.min(lo[d], c)), (hi[d] = Math.max(hi[d], c))));
  let i = 0;
  counts.forEach((run, k) => {
    // Foreground runs (odd indices) may span rows: visit each row segment.
    for (let p = i, end = i + run; k % 2 && p < end; ) {
      const rowEnd = Math.min(end, p - (p % w) + w);
      const y = Math.floor((p % (w * h)) / w);
      const z = Math.floor(p / (w * h));
      see(p % w, y, z);
      see((rowEnd - 1) % w, y, z);
      p = rowEnd;
    }
    i += run;
  });
  return hi[0] < 0 ? null : [lo[0], lo[1], lo[2], hi[0] + 1, hi[1] + 1, hi[2] + 1];
}

function geometryOf(g: Geometry, kind: RevisionKind): RevisionGeometry | null {
  const r = g as Record<string, unknown>;
  switch (g.type) {
    case "box":
      return { box: [g.x, g.y, g.w, g.h] };
    case "polygon":
    case "polyline":
    case "spline":
      return { points: g.points.map((p) => [...p]) };
    case "keypoint":
      return { points: [[g.x, g.y]] };
    case "mask":
      if (g.dims.length === 2) return { mask: toColumnMajor(g.dims, g.counts) };
      if (g.dims.length === 3) {
        const box3d = maskBox3d(g.dims, g.counts);
        return box3d && { box3d };
      }
      return null;
    case "point3d":
      return { box3d: [...g.ijk, ...g.ijk.map((c) => c + 1)] };
    case "measurement": {
      const stats = g.stats ?? {};
      const value = Object.values(stats)[0];
      return value === undefined ? null : { points: g.points.map((p) => p.slice(0, 3)), value, ...(g.unit ? { unit: g.unit } : {}) };
    }
    case "span":
      return { start: g.start, end: g.end };
    case "instant": {
      const t = g.t ?? g.frame;
      return t === undefined ? null : { start: t, end: t };
    }
    default:
      if (kind === "textspan" || kind === "timespan") return typeof r.start === "number" && typeof r.end === "number" ? { start: r.start, end: r.end } : null;
      return null;
  }
}

/**
 * A Studio annotation as a versioning revision, or `null` when its geometry has no v1 kind.
 * Attributes that aren't enum-like tokens (free text) are dropped, never copied.
 */
export function toAnnotationRevision(a: Annotation, ctx: RevisionContext): AnnotationRevision | null {
  const g = a.geometry;
  const kind = g.type === "mask" && g.dims.length === 3 ? "region3d" : (GEOMETRY_KINDS[g.type] ?? ctx.moduleKinds?.[g.type] ?? null);
  if (!kind) return null;
  const geometry = geometryOf(a.geometry, kind);
  if (!geometry) return null;
  const attrs = Object.entries(a.attributes ?? {})
    .map(([k, v]) => [k, String(v).toLowerCase()] as const)
    .filter(([k, v]) => k !== "review_status" && k !== "confidence" && TOKEN.test(k) && TOKEN.test(v));
  const confidence = typeof a.attributes?.confidence === "number" ? a.attributes.confidence : undefined;
  const rev: AnnotationRevision = {
    schema_version: "1",
    annotation_id: a.id,
    sample_id: ctx.sampleId,
    kind,
    class_id: (ctx.classId ?? ((l) => l))(a.label),
    ontology_rev: ctx.ontologyRev,
    geometry,
    coordinate_frame: ctx.coordinateFrame ?? (kind === "timespan" ? "seconds" : kind === "textspan" ? "chars" : kind === "region3d" ? "voxel" : "pixel"),
    status: STATUS[String(a.attributes?.review_status)] ?? "draft",
    ...(confidence !== undefined && confidence >= 0 && confidence <= 1 ? { confidence } : {}),
    ...(attrs.length ? { attributes: Object.fromEntries(attrs) } : {}),
    provenance: { actor_id: a.author, ...(ctx.parentRevision ? { parent_revision: ctx.parentRevision } : {}) },
  };
  return AnnotationRevision.parse(rev);
}
