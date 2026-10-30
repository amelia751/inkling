import { describe, expect, it } from "vitest";
import type { Annotation, Geometry } from "../types";
import { migrateAnnotation, migrateDocument } from "./annotations-v1-to-v2";

const ann = (geometry: Geometry, attributes?: Annotation["attributes"]): Annotation => ({ id: "a", itemId: "i", label: "l", geometry, provenance: "human-created", author: "x", createdAt: "t", attributes });

describe("annotations v1 → v2", () => {
  it.each<[Geometry, Partial<Annotation>]>([
    [{ type: "interval", lead: "II", start: 1, end: 2 }, { geometry: { type: "span", start: 1, end: 2, channel: "II" }, attributes: { kind: "interval" } }],
    [{ type: "beat", lead: "all", t: 0.5, code: "V" }, { geometry: { type: "instant", t: 0.5, channel: "all" }, attributes: { kind: "beat", code: "V" } }],
    [{ type: "wave", lead: "V1", wave: "QRS", onset: 1, peak: 1.05, offset: 1.1 }, { geometry: { type: "span", start: 1, end: 1.1, channel: "V1" }, attributes: { kind: "wave", wave: "QRS", peak: 1.05 } }],
    [{ type: "rhythm", start: 0, end: 4, rhythm: "(AFIB" }, { geometry: { type: "span", start: 0, end: 4, channel: "rhythm" }, attributes: { kind: "rhythm", rhythm: "(AFIB" } }],
    [{ type: "phase", phase: "ED", frame: 3 }, { geometry: { type: "instant", frame: 3 }, attributes: { kind: "phase", phase: "ED" } }],
    [{ type: "segment", start: 1, end: 3 }, { geometry: { type: "span", start: 1, end: 3 } }],
    [{ type: "event", frame: 9 }, { geometry: { type: "instant", frame: 9 } }],
    [{ type: "mark", x: 1, y: 2 }, { geometry: { type: "keypoint", x: 1, y: 2 } }],
    [{ type: "point", plane: "axial", slice: 4, ijk: [1, 2, 4] }, { geometry: { type: "point3d", plane: "axial", slice: 4, ijk: [1, 2, 4] } }],
  ])("%j", (g, want) => {
    expect(migrateAnnotation(ann(g))).toMatchObject(want);
  });

  it("keeps existing attributes and is idempotent", () => {
    const once = migrateAnnotation(ann({ type: "beat", lead: "II", t: 1, code: "N" }, { source: "pan-tompkins" }));
    expect(once.attributes).toEqual({ source: "pan-tompkins", kind: "beat", code: "N" });
    expect(migrateAnnotation(once)).toBe(once);
  });

  it("only rewrites the requested v1 types and stamps the version when done", () => {
    const doc = { revision: 3, annotations: [ann({ type: "mark", x: 0, y: 0 }), ann({ type: "event", frame: 1 })] };
    const partial = migrateDocument(doc, new Set(["mark"]));
    expect(partial.annotations.map((a) => a.geometry.type)).toEqual(["keypoint", "event"]);
    expect(partial.annotationsVersion).toBeUndefined();
    expect(migrateDocument(doc).annotationsVersion).toBe(2);
  });
});
