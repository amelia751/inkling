import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnnotationDiffRules, DIFF_FIELDS } from "./annotation-diff";
import { AnnotationRevision, GEOMETRY_KINDS, REVISION_KINDS, toAnnotationRevision } from "./annotation-revision";
import { PluginManifest, PLUGIN_SCHEMA_VERSION } from "./plugin-manifest";
import type { Annotation, Geometry } from "./types";

// The emitted schemas (read as files: this package imports nothing outside itself).
const schema = (name: string) => JSON.parse(readFileSync(join(__dirname, "../../../schemas/versioning", name), "utf8"));
const diffRulesSchema = schema("annotation-diff-rules.schema.json");
const revisionSchema = schema("annotation-revision.schema.json");

const ann = (geometry: Geometry, extra: Partial<Annotation> = {}): Annotation => ({
  id: "a1",
  itemId: "img/a.png",
  label: "cat",
  geometry,
  provenance: "human-created",
  author: "alice",
  createdAt: "2026-10-30T00:00:00Z",
  ...extra,
});
const ctx = { sampleId: "s1", ontologyRev: "o1" };

describe("annotation revisions", () => {
  it("maps every core geometry kind the versioning service knows", () => {
    expect(new Set(Object.values(GEOMETRY_KINDS).filter(Boolean))).toEqual(new Set(REVISION_KINDS.filter((k) => k !== "textspan")));
    expect(toAnnotationRevision(ann({ type: "box", x: 1, y: 2, w: 3, h: 4 }), ctx)).toMatchObject({ kind: "box2d", geometry: { box: [1, 2, 3, 4] }, coordinate_frame: "pixel", status: "draft", provenance: { actor_id: "alice" } });
    expect(toAnnotationRevision(ann({ type: "polygon", points: [[0, 0], [1, 0], [1, 1]] }), ctx)?.geometry.points).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(toAnnotationRevision(ann({ type: "span", start: 1, end: 2.5 }), ctx)).toMatchObject({ kind: "timespan", coordinate_frame: "seconds", geometry: { start: 1, end: 2.5 } });
    expect(toAnnotationRevision(ann({ type: "point3d", plane: "axial", slice: 3, ijk: [1, 2, 3] }), ctx)?.geometry.box3d).toEqual([1, 2, 3, 2, 3, 4]);
    expect(toAnnotationRevision(ann({ type: "measurement", kind: "length", points: [[0, 0], [3, 4]], space: "image", stats: { length: 5 }, unit: "mm" }), ctx)?.geometry).toEqual({ points: [[0, 0], [3, 4]], value: 5, unit: "mm" });
    expect(toAnnotationRevision(ann({ type: "track", shape: "box", keyframes: [] }), ctx)).toBeNull();
  });

  it("converts 2D masks to column-major RLE and 3D masks to a voxel box", () => {
    // 3×2 (w×h) row-major: row 0 = 0 1 1, row 1 = 0 0 1 → column-major [h, w] = 0 0 | 1 0 | 1 1.
    const r = toAnnotationRevision(ann({ type: "mask", dims: [3, 2], counts: [1, 2, 2, 1] }), ctx);
    expect(r?.geometry.mask).toEqual({ size: [2, 3], counts: [2, 1, 1, 2] });
    // 4×3×2 grid, foreground run covering x 2..3 of row y=2 on z=0 and x 0..1 of row y=0 on z=1.
    const v = toAnnotationRevision(ann({ type: "mask", dims: [4, 3, 2], counts: [10, 4, 10] }), ctx);
    expect(v).toMatchObject({ kind: "region3d", coordinate_frame: "voxel", geometry: { box3d: [0, 0, 0, 4, 3, 2] } });
  });

  it("maps module geometries only when their plugin says how, and drops free-text attributes", () => {
    const span = ann({ type: "acme.text.span", start: 3, end: 9, text: "hello" } as Geometry, { attributes: { review_status: "accepted", occluded: "No", note: "free text here", confidence: 0.7 } });
    expect(toAnnotationRevision(span, ctx)).toBeNull();
    expect(toAnnotationRevision(span, { ...ctx, moduleKinds: { "acme.text.span": "textspan" } })).toMatchObject({
      kind: "textspan",
      coordinate_frame: "chars",
      status: "accepted",
      confidence: 0.7,
      attributes: { occluded: "no" },
      geometry: { start: 3, end: 9 },
    });
  });

  it("rejects a kind without its required geometry", () => {
    const bad = { schema_version: "1", annotation_id: "a", sample_id: "s", kind: "mask2d", class_id: "c", ontology_rev: "o", geometry: { box: [0, 0, 1, 1] }, coordinate_frame: "pixel", status: "draft", provenance: { actor_id: "u" } };
    expect(AnnotationRevision.safeParse(bad).success).toBe(false);
  });
});

describe("annotations.diff (V13)", () => {
  const rulesSchema = diffRulesSchema;
  const item = rulesSchema.properties.rules.items;

  it("matches the versioning service's diff-rules schema", () => {
    expect(item.properties.kind.enum).toEqual([...REVISION_KINDS]);
    expect(rulesSchema.$defs.fields.items.enum).toEqual([...DIFF_FIELDS]);
    expect(item.properties.geometry.properties.metric.enum).toEqual(["iou", "max_vertex_delta_px", "abs_delta", "exact"]);
    expect(Object.keys(item.properties).sort()).toEqual(["compare_fields", "conflict_fields", "geometry", "kind"]);
    expect(revisionSchema.properties.kind.enum).toEqual([...REVISION_KINDS]);
  });

  it("is optional in plugin.yaml and validated when present", () => {
    const base = { schemaVersion: PLUGIN_SCHEMA_VERSION, id: "acme.seg", name: "Seg", version: "1.0.0", publisher: "acme", license: "MIT", compatibility: { studio: "*", pluginApi: "^1" }, runtime: { kind: "none" }, permissions: {} };
    expect(PluginManifest.safeParse(base).success).toBe(true);
    const diff = [{ kind: "mask2d", geometry: { metric: "iou", threshold: 0.95 }, conflict_fields: ["class_id", "geometry"] }];
    expect(PluginManifest.safeParse({ ...base, annotations: { diff } }).success).toBe(true);
    for (const bad of [
      [{ kind: "mask2d", geometry: { metric: "iou", threshold: 1.5 } }],
      [{ kind: "cube", geometry: { metric: "exact", threshold: 0 } }],
      [{ kind: "box2d", geometry: { metric: "exact", threshold: 0 }, compare_fields: ["text"] }],
      [...diff, ...diff],
    ])
      expect(AnnotationDiffRules.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(PluginManifest.safeParse({ ...base, annotations: { diff, run: "x" } }).success).toBe(false);
  });
});
