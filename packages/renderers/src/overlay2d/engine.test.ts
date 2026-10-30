import { describe, expect, it } from "vitest";
import type { Annotation, Geometry, Pt } from "@studio/contracts/types";
import { onPlacement } from "./OverlayEngine";
import { deleteVertex, dragHandle, handlesOf, insertVertex } from "./edit";
import { geometryFromRegion, regionArea, regionOf, subtractRegion, translateGeometry, unionRegions, type Region } from "./regions";
import { Scene } from "./scene";
import { View } from "./transform";

const ann = (id: string, geometry: Geometry, label = "tumor"): Annotation => ({ id, itemId: "i", label, geometry, provenance: "human-created", author: "t", createdAt: "" });
const sq = (x: number, y: number, s: number): Pt[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

describe("View (Transform2D)", () => {
  it("camera: pan/zoom maps like useViewport2D and round-trips", () => {
    const v = new View().setCamera({ scale: 2, tx: 10, ty: 20 }, 400, 300);
    expect(v.toScreen(5, 5)).toEqual([20, 30]);
    expect(v.toImage(20, 30)).toEqual([5, 5]);
    expect(v.scale).toBe(2);
    expect(v.visibleImageBounds()).toEqual([-5, -10, 195, 140]);
  });

  it("camera: rotation and mirror about the stage centre", () => {
    const v = new View().setCamera({ scale: 1, tx: 0, ty: 0, rotation: 90 }, 200, 200);
    const [x, y] = v.toScreen(100, 0); // top centre → right centre after a 90° clockwise turn
    expect(x).toBeCloseTo(200);
    expect(y).toBeCloseTo(100);
    const [cx, cy] = v.toScreen(200, 100);
    expect(cx).toBeCloseTo(100);
    expect(cy).toBeCloseTo(200);
    const f = new View().setCamera({ scale: 1, tx: 0, ty: 0, flipX: true }, 200, 200);
    expect(f.toScreen(0, 0)).toEqual([200, 0]);
    for (const view of [v, f]) {
      const back = view.toImage(...view.toScreen(37, 81));
      expect(back[0]).toBeCloseTo(37);
      expect(back[1]).toBeCloseTo(81);
    }
  });
});

describe("Scene", () => {
  it("hit-tests points before regions and the smallest containing region among nested ones", () => {
    const s = new Scene();
    s.build([ann("big", { type: "polygon", points: sq(0, 0, 100) }), ann("small", { type: "box", x: 40, y: 40, w: 20, h: 20 }), ann("pt", { type: "keypoint", x: 50, y: 50 }), ann("line", { type: "polyline", points: [[0, 200], [100, 200]] })]);
    expect(s.hitTest([50, 50], 2)?.a.id).toBe("pt");
    expect(s.hitTest([45, 45], 2)?.a.id).toBe("small");
    expect(s.hitTest([10, 10], 2)?.a.id).toBe("big");
    expect(s.hitTest([50, 201], 2)?.a.id).toBe("line");
    expect(s.hitTest([500, 500], 2)).toBeNull();
    expect(s.hitTest([50, 50], 2, (e) => e.kind === "region")?.a.id).toBe("small");
  });

  it("patches the index for small edits and answers like a fresh build", () => {
    const list = Array.from({ length: 200 }, (_, i) => ann(`k${i}`, { type: "keypoint", x: i * 10, y: 5 }));
    const s = new Scene();
    s.build(list);
    expect(s.lastBuild.mode).toBe("full");
    const moved = list.map((a, i) => (i === 3 ? { ...a, geometry: { type: "keypoint" as const, x: 5000, y: 5000 } } : a)).filter((_, i) => i !== 7);
    s.build([...moved, ann("new", { type: "keypoint", x: 1, y: 1 })]);
    expect(s.lastBuild.mode).toBe("patch");
    expect(s.size).toBe(200);
    const ids = (sc: Scene) => sc.search(0, 0, 100, 10).map((k) => sc.entries[k].a.id).sort();
    const fresh = new Scene();
    fresh.build([...moved, ann("new", { type: "keypoint", x: 1, y: 1 })]);
    expect(ids(s)).toEqual(ids(fresh));
    expect(ids(s)).not.toContain("k3");
    expect(ids(s)).not.toContain("k7");
    expect(s.get("k7")).toBeUndefined();
  });
});

describe("regions", () => {
  it("union / subtract / holes / pieces", () => {
    const a: Region = [[sq(0, 0, 10)]];
    const b: Region = [[sq(5, 0, 10)]];
    expect(regionArea(unionRegions(a, b))).toBeCloseTo(150);
    const hole = subtractRegion([[sq(0, 0, 10)]], [[sq(4, 4, 2)]]);
    expect(regionArea(hole)).toBeCloseTo(96);
    expect(geometryFromRegion(hole)).toMatchObject({ type: "polygon", holes: [expect.any(Array)] });
    const split = subtractRegion([[sq(0, 0, 10)]], [[[[4, -1], [6, -1], [6, 11], [4, 11]]]]);
    expect(geometryFromRegion(split)?.type).toBe("multipolygon");
    expect(regionArea(split)).toBeCloseTo(80);
  });

  it("regionOf normalises boxes, ellipses and polygons; translate keeps area", () => {
    expect(regionArea(regionOf({ type: "box", x: 0, y: 0, w: 4, h: 5 })!)).toBe(20);
    expect(regionArea(regionOf({ type: "ellipse", cx: 0, cy: 0, rx: 10, ry: 5 })!)).toBeCloseTo(Math.PI * 50, -1);
    const g: Geometry = { type: "polygon", points: sq(0, 0, 10), holes: [sq(2, 2, 2)] };
    expect(regionArea(regionOf(translateGeometry(g, 7, -3))!)).toBe(96);
  });
});

describe("vertex editing", () => {
  const view = new View().setCamera({ scale: 1, tx: 0, ty: 0 }, 100, 100);

  it("handles cover every ring; dragging, inserting and deleting vertices", () => {
    const g: Geometry = { type: "polygon", points: sq(0, 0, 10), holes: [sq(2, 2, 2)] };
    const hs = handlesOf(g, view);
    expect(hs).toHaveLength(8);
    expect(hs[5].ref).toEqual({ kind: "ring", ring: 1, i: 1 });
    const moved = dragHandle(structuredClone(g), g, { kind: "ring", ring: 0, i: 0 }, [-1, -1]);
    expect((moved as { points: Pt[] }).points[0]).toEqual([-1, -1]);
    const ins = insertVertex(g, 0, 1, [5, 0])!;
    expect((ins as { points: Pt[] }).points).toHaveLength(5);
    expect(deleteVertex(ins, { kind: "ring", ring: 0, i: 1 })).toEqual(g);
    expect(deleteVertex({ type: "polygon", points: sq(0, 0, 1).slice(0, 3) }, { kind: "ring", ring: 0, i: 0 })).toBeNull();
  });

  it("box corners resize against the opposite corner; ellipse axes set radii", () => {
    const box: Geometry = { type: "box", x: 0, y: 0, w: 10, h: 10 };
    expect(dragHandle(box, box, { kind: "corner", i: 0 }, [12, 15])).toEqual({ type: "box", x: 10, y: 10, w: 2, h: 5 });
    const el: Geometry = { type: "ellipse", cx: 0, cy: 0, rx: 5, ry: 5 };
    expect(dragHandle(el, el, { kind: "axis", i: 2 }, [0, 9])).toMatchObject({ rx: 5, ry: 9 });
  });
});

describe("placement", () => {
  it("filters by every key the placement sets; no placement shows everything", () => {
    const g = { type: "box", x: 0, y: 0, w: 1, h: 1, frame: 3, slice: 1 } as Geometry;
    expect(onPlacement(g, undefined)).toBe(true);
    expect(onPlacement(g, { frame: 3 })).toBe(true);
    expect(onPlacement(g, { frame: 3, slice: 2 })).toBe(false);
    expect(onPlacement({ type: "keypoint", x: 0, y: 0 }, { frame: 0 })).toBe(false);
  });
});
