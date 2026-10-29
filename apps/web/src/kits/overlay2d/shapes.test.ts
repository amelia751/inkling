import { describe, expect, it } from "vitest";
import type { Geometry, Pt } from "@/types";
import { shapeUtil, type ToScreen } from "./shapes";

// jsdom has no Path2D; hit-tests and geometry math don't need it.
const id: ToScreen = (x, y) => [x, y];
const zoom2: ToScreen = (x, y) => [x * 2 + 10, y * 2 + 10];

const SHAPES: Geometry[] = [
  { type: "box", x: 10, y: 20, w: 30, h: 40 },
  { type: "ellipse", cx: 50, cy: 50, rx: 20, ry: 10 },
  { type: "polygon", points: [[0, 0], [40, 0], [40, 40], [0, 40]] },
  { type: "polyline", points: [[0, 0], [10, 10], [30, 10]] },
  { type: "spline", points: [[0, 0], [40, 0], [40, 40], [0, 40]] },
  { type: "keypoint", x: 5, y: 7 },
  { type: "multipolygon", polygons: [[[[0, 0], [10, 0], [10, 10], [0, 10]]], [[[20, 20], [30, 20], [30, 30], [20, 30]]]] },
];

describe("ShapeUtil", () => {
  it.each(SHAPES.map((g) => [g.type, g] as const))("%s: translate round-trips and moves bounds", (_t, g) => {
    const u = shapeUtil(g)!;
    const there = u.translate(g, 7, -3);
    const b0 = u.bounds(g), b1 = u.bounds(there);
    expect(b1.map((v, i) => v - b0[i])).toEqual([7, -3, 7, -3].map((v) => expect.closeTo(v, 6)));
    expect(u.translate(there, -7, 3)).toEqual(g);
  });

  it("box: body hit, handle hit when selected, miss outside", () => {
    const g = SHAPES[0];
    const u = shapeUtil(g)!;
    expect(u.hitTest(g, [25, 40], id)).toEqual({ part: "body" });
    expect(u.hitTest(g, [10, 20], id, { selected: true })).toEqual({ part: "handle", index: 0 });
    expect(u.hitTest(g, [100, 100], id)).toBeNull();
    // Hit-testing happens in screen space.
    expect(u.hitTest(g, [25, 40], zoom2)).toBeNull();
    expect(u.hitTest(g, [60, 90], zoom2)).toEqual({ part: "body" });
  });

  it("box: dragging a corner past the opposite one normalises", () => {
    const u = shapeUtil(SHAPES[0])!;
    expect(u.applyHandle(SHAPES[0], 4, [0, 0] as Pt)).toEqual({ type: "box", x: 0, y: 0, w: 10, h: 20 });
    expect(u.applyHandle(SHAPES[0], 3, [60, 999] as Pt)).toEqual({ type: "box", x: 10, y: 20, w: 50, h: 40 });
  });

  it("ellipse: handle drag resizes about the opposite side", () => {
    const g = SHAPES[1];
    const out = shapeUtil(g)!.applyHandle(g, 3, [90, 50]);
    expect(out).toMatchObject({ cx: 60, rx: 30, cy: 50, ry: 10 });
    expect(shapeUtil(g)!.hitTest(g, [50, 50], id)).toEqual({ part: "body" });
    expect(shapeUtil(g)!.hitTest(g, [50, 75], id)).toBeNull();
  });

  it("polygon: vertex, edge and interior hits", () => {
    const g = SHAPES[2];
    const u = shapeUtil(g)!;
    expect(u.hitTest(g, [40, 40], id, { selected: true })).toEqual({ part: "handle", index: 2 });
    expect(u.hitTest(g, [20, 0], id, { selected: true })).toEqual({ part: "edge", index: 1 });
    expect(u.hitTest(g, [20, 20], id)).toEqual({ part: "body" });
    expect(u.applyHandle(g, 0, [-5, -5])).toMatchObject({ points: [[-5, -5], [40, 0], [40, 40], [0, 40]] });
  });

  it("polyline: open, so the interior isn't a hit", () => {
    const g = SHAPES[3];
    const u = shapeUtil(g)!;
    expect(u.hitTest(g, [15, 2], id)).toBeNull();
    expect(u.hitTest(g, [20, 10], id)).toEqual({ part: "body" });
    expect(u.hitTest(g, [15, 0], id, { selected: true })).toBeNull();
  });

  it("spline: bounds follow the smooth outline, not just the control points", () => {
    const b = shapeUtil(SHAPES[4])!.bounds(SHAPES[4]);
    expect(b[0]).toBeLessThanOrEqual(0);
    expect(b[2]).toBeGreaterThanOrEqual(40);
  });

  it("keypoint: tolerance in screen pixels; handle when selected", () => {
    const g = SHAPES[5];
    const u = shapeUtil(g)!;
    expect(u.hitTest(g, [10, 10], id)).toEqual({ part: "body" });
    expect(u.hitTest(g, [30, 30], id)).toBeNull();
    expect(u.hitTest(g, [5, 7], id, { selected: true })).toEqual({ part: "handle", index: 0 });
    expect(u.applyHandle(g, 0, [1, 2])).toEqual({ type: "keypoint", x: 1, y: 2 });
  });

  it("multipolygon: holes and parts", () => {
    const g: Geometry = { type: "multipolygon", polygons: [[[[0, 0], [30, 0], [30, 30], [0, 30]], [[10, 10], [20, 10], [20, 20], [10, 20]]]] };
    const u = shapeUtil(g)!;
    expect(u.hitTest(g, [5, 5], id)).toEqual({ part: "body" });
    expect(u.hitTest(g, [15, 15], id, { tol: 1 })).toBeNull();
    expect(u.handles(g)).toEqual([]);
  });

  it("has no util for non-planar geometries", () => {
    expect(shapeUtil({ type: "span", start: 0, end: 1 })).toBeUndefined();
  });
});
