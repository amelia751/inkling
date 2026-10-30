import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { describeGeometry } from "@/extension-host/describe";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment } from "@/extension-host/resolve";
import { migrateDocument } from "@studio/contracts/migrations/annotations-v1-to-v2";
import type { Annotation, Pt } from "@studio/contracts/types";
import { describeInstant } from "./geometries";
import { cellAreas, cellLabelMap, frameCoverage, groupCells, isPhase, paintOrder, phaseOps, resolvePhases, ring, type Grid, type Structures } from "./model";
import { cineConfig, CINE_RENDERER } from "./public";
import { copyCell, importReference, interpolateCells } from "./renderer/edits";
import { dragMove, dragVertex, edgeInsertIndex, pickAt } from "./renderer/engine";
import { NS, ns } from "@studio/contracts/naming";

const LABELS = ["right ventricle", "myocardium", "left ventricle"];
const S: Structures = { rv: "right ventricle", myo: "myocardium", lv: "left ventricle" };
const NONE: Structures = { rv: undefined, myo: undefined, lv: undefined };
const GRID: Grid = { nx: 20, ny: 20, nz: 3, frames: 4, spacing: [1, 1, 10] };
const square = (x: number, y: number, s: number): Pt[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

let n = 0;
const ann = (label: string, geometry: Annotation["geometry"], attributes?: Annotation["attributes"]): Annotation => ({
  id: `a${++n}`,
  itemId: "study",
  label,
  geometry,
  attributes,
  provenance: "human-created",
  author: "t",
  createdAt: "",
}) as unknown as Annotation;
const newAnn = (init: { label: string; geometry: Annotation["geometry"]; attributes: Annotation["attributes"] }) => ann(init.label, init.geometry, init.attributes);

describe(`${NS}.cine model`, () => {
  it("paints roles last (LV carves the myocardium ring), other labels first", () => {
    expect(paintOrder(["other", ...LABELS], S)).toEqual(["other", ...LABELS]);
    expect(paintOrder(["left ventricle", "myocardium", "right ventricle"], S)).toEqual(["right ventricle", "myocardium", "left ventricle"]);
    const cells = groupCells(
      [ann("myocardium", { type: "polygon", points: square(2, 2, 10), slice: 0, frame: 0 }), ann("left ventricle", { type: "polygon", points: square(4, 4, 6), slice: 0, frame: 0 })],
      "study",
    );
    const map = cellLabelMap(cells.get("0:0")!, LABELS, S, 20, 20);
    expect(map[5 * 20 + 5]).toBe(3); // inside the LV
    expect(map[3 * 20 + 3]).toBe(2); // myocardium ring
    // Enclosure rule: myocardium area = epi − LV.
    const a = cellAreas(cells.get("0:0")!, LABELS, S, GRID);
    expect(a.lv).toBeCloseTo(36);
    expect(a.myo).toBeCloseTo(100 - 36);
    expect(cellAreas(cells.get("0:0")!, LABELS, NONE, GRID)).toEqual({ rv: 0, myo: 0, lv: 0 });
  });

  it("reports coverage: gaps make a structure partial", () => {
    const anns = [0, 2].map((z) => ann("left ventricle", { type: "polygon", points: square(2, 2, 5), slice: z, frame: 1 }));
    const f = frameCoverage({ annotations: anns, itemId: "study", labels: LABELS, structures: S, grid: GRID });
    expect(f).toHaveLength(4);
    expect(f[1].status.lv).toBe("partial");
    expect(f[1].missing.lv).toEqual([1]);
    expect(f[1].volume.lv).toBeCloseTo((2 * 25 * 10) / 1000);
    expect(f[0].status.lv).toBe("empty");
  });

  it("resolves key frames from markers, references and meta; phaseOps moves or creates instants", () => {
    const assets = [{ path: "r", sha256: "", bytes: 0, role: "reference" as const, phase: "ES" as const, frame: 2 }];
    let anns: Annotation[] = [];
    expect(resolvePhases(anns, "study", assets, { ed: 0 }, ["ED", "ES"])).toEqual({ ED: { frame: 0, source: "meta" }, ES: { frame: 2, source: "reference" } });
    const ops = phaseOps(anns, "study", { ED: 3 }, (init) => ann("left ventricle", init.geometry, init.attributes));
    expect(ops.upsert[0].geometry).toEqual({ type: "instant", frame: 3 });
    expect(ops.upsert[0].attributes).toEqual({ kind: "phase", phase: "ED" });
    anns = ops.upsert;
    expect(isPhase(anns[0])).toBe(true);
    expect(resolvePhases(anns, "study", assets, undefined, ["ED"]).ED).toMatchObject({ frame: 3, source: "marked" });
    expect(phaseOps(anns, "study", { ED: 1 }, () => { throw new Error("no create"); }).update).toEqual([{ id: anns[0].id, patch: { geometry: { type: "instant", frame: 1 } } }]);
  });

  it("migrated v1 phase geometries read as key frames", () => {
    const doc = migrateDocument(
      { version: 1, annotations: [{ ...ann("left ventricle", { type: "phase", phase: "ES", frame: 12 }) }] } as never,
      new Set(["phase"]),
    );
    const a = doc.annotations[0];
    expect(isPhase(a)).toBe(true);
    expect(resolvePhases(doc.annotations, "study", [], undefined, ["ES"]).ES?.frame).toBe(12);
    expect(describeInstant(a.geometry, a)).toBe("ES · frame 13");
    expect(describeInstant({ type: "instant", frame: 4 }, ann("x", { type: "instant", frame: 4 }))).toBe("Event · frame 5");
  });
});

describe(`${NS}.cine edits`, () => {
  const lv = ann("left ventricle", { type: "spline", points: square(2, 2, 8), slice: 1, frame: 0 }, { source: "manual" });
  const cells = groupCells([lv], "study");
  const all = () => true;

  it("copies to the next frame (cyclic) and refuses off-volume slices", () => {
    const r = copyCell({ cells, cell: cells.get("1:0")!, slice: 1, frame: 0, nz: 3, nt: 4, dz: 0, df: -1, replace: false, selected: [], visible: all, editable: all, newAnn });
    expect(typeof r).toBe("object");
    if (typeof r === "string") return;
    expect(r.goto).toEqual({ slice: 1, frame: 3 });
    expect(r.upsert[0].geometry).toMatchObject({ slice: 1, frame: 3, points: lv.geometry.type === "spline" ? lv.geometry.points : [] });
    expect(r.upsert[0].attributes?.source).toBe("copied");
    expect(copyCell({ cells, cell: cells.get("1:0")!, slice: 1, frame: 0, nz: 2, nt: 4, dz: 1, df: 0, replace: false, selected: [], visible: all, editable: all, newAnn })).toBe("No slice in that direction");
  });

  it("interpolates between key frames, optionally wrapping the cycle", () => {
    const other = ann("left ventricle", { type: "spline", points: square(4, 4, 4), slice: 1, frame: 2 }, { source: "manual" });
    const c2 = groupCells([lv, other], "study");
    const r = interpolateCells({ cells: c2, axis: "frame", slice: 1, frame: 0, nz: 3, nt: 5, cyclic: false, targets: ["left ventricle"], newAnn });
    expect(typeof r !== "string" && r.upsert.map((a) => (a.geometry as { frame: number }).frame)).toEqual([1]);
    const w = interpolateCells({ cells: c2, axis: "frame", slice: 1, frame: 0, nz: 3, nt: 5, cyclic: true, targets: ["left ventricle"], newAnn });
    expect(typeof w !== "string" && w.upsert.map((a) => (a.geometry as { frame: number }).frame)).toEqual([1, 3, 4]);
  });

  it("imports a reference label volume as splines, the myocardium as its outer border", () => {
    const data = new Uint8Array(20 * 20);
    for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) data[y * 20 + x] = y >= 5 && y < 11 && x >= 5 && x < 11 ? 3 : 2;
    const r = importReference({ refs: [{ frame: 0, volume: { data } }], slices: [0], cells: new Map(), labels: LABELS, structs: S, nx: 20, ny: 20, newAnn });
    if (typeof r === "string") throw new Error(r);
    expect(r.upsert.map((a) => a.label)).toEqual(["myocardium", "left ventricle"]);
    const xs = (a: Annotation) => (a.geometry as { points: Pt[] }).points.map((p) => p[0]);
    expect(Math.min(...xs(r.upsert[0]))).toBeLessThan(Math.min(...xs(r.upsert[1])));
  });
});

describe(`${NS}.cine engine`, () => {
  const g = { type: "spline" as const, points: square(0, 0, 10), slice: 0, frame: 0 };
  it("edits through ShapeUtils with 0.01 precision", () => {
    expect(dragVertex({ kind: "vertex", id: "x", index: 1, points: g.points }, [12.3456, 1.004])[1]).toEqual([12.35, 1]);
    expect(dragMove({ kind: "move", id: "x", start: [0, 0], points: g.points, origin: g.points }, [1.111, 2])[0]).toEqual([1.11, 2]);
  });
  it("hit-tests edges and picks the smallest enclosing contour", () => {
    const poly = { ...g, type: "polygon" as const };
    expect(edgeInsertIndex(poly, [5, 0], 0.5)).toBe(1);
    expect(edgeInsertIndex(poly, [5, 5], 0.5)).toBe(-1);
    // Splines insert after the control point whose segment of the dense outline was hit.
    expect(edgeInsertIndex(g, ring(g)[6], 0.5)).toBe(1);
    const big = ann("a", g), small = ann("b", { ...g, points: square(3, 3, 2) });
    const cells = groupCells([big, small], "study");
    expect(pickAt(cells.get("0:0")!, [4, 4], 0.5, () => true, 20, 20)?.id).toBe(small.id);
    expect(pickAt(cells.get("0:0")!, [1, 8], 0.5, () => true, 20, 20)?.id).toBe(big.id);
  });
});

describe(`${NS}.cine environment`, () => {
  it("preset:cine-4d configures structures and key frames, and includes cardiac metrics", () => {
    const env = resolveEnvironment({ extends: "preset:cine-4d" }, registry).env!;
    expect(cineConfig(env).structures).toEqual(S);
    expect(cineConfig(env).keyFrames.map((k) => k.id)).toEqual(["ED", "ES"]);
    expect(env.panels.right.map((p) => p.id)).toContain(ns("cardiac-metrics.panels.metrics"));
    expect(env.exporters.map((e) => e.id)).toContain(ns("cardiac-metrics.exporters.function-csv"));
    const a = ann("left ventricle", { type: "instant", frame: 0 }, { kind: "phase", phase: "ED" });
    expect(describeGeometry(a, env)).toBe("ED · frame 1");
  });
  it("works without cardiac vocabulary: no structures, no key frames, no metrics", () => {
    const r = resolveEnvironment(
      {
        data: { kind: ns("cine.dataKinds.volume-time") },
        viewports: [{ name: "main", renderer: CINE_RENDERER }],
        tools: [ns("core.tools.select"), ns("overlay2d.tools.polygon")],
        exporters: [ns("cine.exporters.acdc-nifti")],
        labels: [{ name: "cells", control: "PolygonLabels", classes: [{ id: "nucleus" }] }],
      },
      registry,
    );
    expect(r.errors).toBeUndefined();
    expect(cineConfig(r.env)).toEqual({ structures: {}, keyFrames: [] });
    expect(r.env!.panels.right.map((p) => p.id)).not.toContain(ns("cardiac-metrics.panels.metrics"));
  });
});
