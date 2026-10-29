import { beforeEach, describe, expect, it, vi } from "vitest";
import { isEditable, newAnnotation, useStudio } from "@/stores/studio";
import type { Annotation, Geometry, Pt } from "@/types";
import { Scene } from "../scene";
import { View } from "../transform";
import { regionArea, regionOf, type Region } from "../regions";
import { applyRegion, brushTool, defaultTools, lengthTool, pathTool, pointTool, selectTool, shapeTool, type PointerInput, type ToolContext, type ToolMachine, type Units } from ".";

// jsdom has no canvas: a stroke becomes its padded bounding box (enough to test the tool logic).
vi.mock("../regions", async (orig) => {
  const m = await orig<typeof import("../regions")>();
  return {
    ...m,
    strokeToRegion: (pts: Pt[], r: number): Region => {
      const [x0, y0, x1, y1] = m.ringsBounds([pts]);
      return [[[[x0 - r, y0 - r], [x1 + r, y0 - r], [x1 + r, y1 + r], [x0 - r, y1 + r]]]];
    },
  };
});

const ITEM = "slide-1";
const UNITS: Units = { formatLength: (px) => `${px}px`, formatArea: (a) => `${a}px²`, lengthStats: (px) => ({ length_um: px / 2 }), unit: "µm" };

/** Fake host: a 2× zoom with a 10 px offset (screen = 2·image + 10), the real store and a scene kept in step with it. */
function makeCtx() {
  const view = new View().setCamera({ scale: 2, tx: 10, ty: 10 }, 800, 600);
  const scene = new Scene();
  const sync = () => scene.build(useStudio.getState().annotations.filter((a) => a.itemId === ITEM));
  const deselect = vi.fn();
  const ctx: ToolContext = {
    view,
    scene,
    itemId: ITEM,
    units: UNITS,
    busy: false,
    store: () => useStudio.getState(),
    editable: (a) => isEditable(a, useStudio.getState().lockedLabels),
    selected: () => (sync(), scene.get(useStudio.getState().selectedId)),
    create(geometry, select = true) {
      const s = useStudio.getState();
      if (!s.activeLabel) return null;
      const a = newAnnotation({ itemId: ITEM, label: s.activeLabel, geometry });
      s.add(a);
      if (select) s.select(a.id);
      sync();
      return a;
    },
    applyRegion: (region, op, target) => (sync(), applyRegion(ctx, region, op, target), sync()),
    deselectOnClick: deselect,
    setBusy: () => {},
  };
  return { ctx, sync, deselect };
}

/** Pointer input at image point (x, y). */
const at = (ctx: ToolContext, x: number, y: number, mods: Partial<PointerInput> = {}): PointerInput => ({ p: [x, y], screen: ctx.view.toScreen(x, y), shift: false, alt: false, dbl: false, ...mods });

function drag(t: ToolMachine, ctx: ToolContext, pts: Pt[], mods: Partial<PointerInput> = {}) {
  const res = t.down(at(ctx, ...pts[0], mods), ctx);
  for (const p of pts.slice(1)) t.move?.(at(ctx, ...p, mods), ctx);
  t.up?.(at(ctx, ...pts[pts.length - 1], mods), ctx);
  return res;
}
const click = (t: ToolMachine, ctx: ToolContext, x: number, y: number, mods: Partial<PointerInput> = {}) => drag(t, ctx, [[x, y]], mods);

const anns = () => useStudio.getState().annotations;
const add = (geometry: Geometry, label = "tumor"): Annotation => {
  const a = newAnnotation({ itemId: ITEM, label, geometry });
  useStudio.getState().add(a);
  return a;
};

beforeEach(() => {
  useStudio.getState().load("p", [], 0, "tumor");
  useStudio.getState().setTool("select");
});

describe("shape tools", () => {
  it("box: drag creates a rounded box and selects it; Shift makes a square; misclicks are dropped", () => {
    const { ctx } = makeCtx();
    const t = shapeTool("box");
    expect(drag(t, ctx, [[10.04, 20], [50, 41.26]])).toBe("claim");
    expect(drag(t, ctx, [[100, 100], [130, 110]], { shift: true })).toBe("claim");
    drag(t, ctx, [[200, 200], [200.5, 200.5]]); // 1 screen px: dropped
    const [a, b] = anns();
    expect(anns()).toHaveLength(2);
    expect(a.geometry).toEqual({ type: "box", x: 10, y: 20, w: 40, h: 21.3 });
    expect(b.geometry).toMatchObject({ type: "box", w: 30, h: 30 });
    expect(useStudio.getState().selectedId).toBe(b.id);
    expect(t.draft()).toBeNull();
  });

  it("ellipse: draft follows the pointer until release", () => {
    const { ctx } = makeCtx();
    const t = shapeTool("ellipse");
    t.down(at(ctx, 0, 0), ctx);
    t.move!(at(ctx, 40, 20), ctx);
    expect(t.draft()).toMatchObject({ kind: "shape", a: [0, 0], b: [40, 20] });
    t.up!(at(ctx, 40, 20), ctx);
    expect(anns()[0].geometry).toEqual({ type: "ellipse", cx: 20, cy: 10, rx: 20, ry: 10 });
  });

  it("needs an active label; Escape-style cancel drops the draft", () => {
    const t = shapeTool("box");
    expect(t.needsLabel).toBe(true);
    const { ctx } = makeCtx();
    t.down(at(ctx, 0, 0), ctx);
    t.cancel();
    t.up?.(at(ctx, 50, 50), ctx);
    expect(anns()).toEqual([]);
  });
});

describe("path tools", () => {
  it("polygon: clicks place vertices, Backspace drops one, Enter closes; the hint counts points", () => {
    const { ctx } = makeCtx();
    const t = pathTool("polygon");
    for (const [x, y] of [[0, 0], [100, 0], [100, 100], [50, 120]] as Pt[]) click(t, ctx, x, y);
    expect(t.hint!()).toMatch(/^4 points/);
    expect(t.removeLast!(ctx)).toBe(true);
    expect(t.hint!()).toMatch(/^3 points/);
    expect(t.finish!(ctx)).toBe(true);
    expect(anns()[0].geometry).toEqual({ type: "polygon", points: [[0, 0], [100, 0], [100, 100]] });
    expect(t.finish!(ctx)).toBe(false);
    expect(t.removeLast!(ctx)).toBe(false);
  });

  it("polygon: clicking the first vertex closes it; a double-click finishes", () => {
    const { ctx } = makeCtx();
    const t = pathTool("polygon");
    for (const [x, y] of [[0, 0], [100, 0], [100, 100]] as Pt[]) click(t, ctx, x, y);
    expect(click(t, ctx, 1, 1)).toBe("consume");
    expect(anns()).toHaveLength(1);
    for (const [x, y] of [[200, 0], [300, 0], [300, 100]] as Pt[]) click(t, ctx, x, y);
    expect(click(t, ctx, 300, 100, { dbl: true })).toBe("consume");
    expect((anns()[1].geometry as { points: Pt[] }).points).toHaveLength(3);
  });

  it("freehand: one drag traces a simplified closed outline", () => {
    const { ctx } = makeCtx();
    const t = pathTool("freehand");
    const ring: Pt[] = Array.from({ length: 41 }, (_, i) => [100 + 50 * Math.cos((i / 40) * 2 * Math.PI), 100 + 50 * Math.sin((i / 40) * 2 * Math.PI)]);
    drag(t, ctx, ring);
    const g = anns()[0].geometry;
    expect(g.type).toBe("polygon");
    expect(regionArea(regionOf(g)!)).toBeGreaterThan(Math.PI * 50 * 50 * 0.95);
  });

  it("polyline: needs two points; tiny polygons are dropped", () => {
    const { ctx } = makeCtx();
    const line = pathTool("polyline");
    click(line, ctx, 0, 0);
    click(line, ctx, 50, 0);
    line.finish!(ctx);
    expect(anns()[0].geometry).toEqual({ type: "polyline", points: [[0, 0], [50, 0]] });
    const poly = pathTool("polygon");
    for (const [x, y] of [[0, 0], [0.5, 0], [0.5, 0.5]] as Pt[]) click(poly, ctx, x, y);
    poly.finish!(ctx);
    expect(anns()).toHaveLength(1);
  });
});

describe("click and measure tools", () => {
  it("point: each click adds a keypoint (0.1 px) without selecting it", () => {
    const { ctx } = makeCtx();
    const t = pointTool();
    expect(click(t, ctx, 10.123, 20.987)).toBe("consume");
    click(t, ctx, 30, 40);
    expect(anns().map((a) => a.geometry)).toEqual([{ type: "keypoint", x: 10.1, y: 21 }, { type: "keypoint", x: 30, y: 40 }]);
    expect(useStudio.getState().selectedId).toBeNull();
  });

  it("length: a measurement with the host's units", () => {
    const { ctx } = makeCtx();
    drag(lengthTool(), ctx, [[0, 0], [30, 40]]);
    expect(anns()[0].geometry).toEqual({ type: "measurement", kind: "length", points: [[0, 0], [30, 40]], space: "image", stats: { length_um: 25 }, unit: "µm" });
  });

  it("defaultTools maps the overlay2d tool names (pan has none: the host pans)", () => {
    const tools = defaultTools();
    expect(Object.keys(tools).sort()).toEqual(["box", "brush", "ellipse", "eraser", "freehand", "keypoint", "length", "mark", "polygon", "polyline", "select"]);
  });
});

describe("select tool", () => {
  const square = (x: number, y: number, s = 100): Geometry => ({ type: "polygon", points: [[x, y], [x + s, y], [x + s, y + s], [x, y + s]] });

  it("click selects, Shift toggles, a click on empty canvas is left to the host", () => {
    const { ctx, sync, deselect } = makeCtx();
    const a = add(square(0, 0)), b = add(square(200, 0));
    sync();
    const t = selectTool();
    click(t, ctx, 50, 50);
    expect(useStudio.getState().selectedIds).toEqual([a.id]);
    expect(click(t, ctx, 250, 50, { shift: true })).toBe("consume");
    expect(useStudio.getState().selectedIds.sort()).toEqual([a.id, b.id].sort());
    expect(t.down(at(ctx, 500, 500), ctx)).toBe("pass");
    expect(deselect).toHaveBeenCalledOnce();
  });

  it("dragging the body moves it as one undo step; dragging a vertex reshapes", () => {
    const { ctx, sync } = makeCtx();
    const a = add(square(0, 0));
    sync();
    const t = selectTool();
    click(t, ctx, 50, 50);
    drag(t, ctx, [[50, 50], [60, 70], [70, 80]]);
    expect((anns()[0].geometry as { points: Pt[] }).points[0]).toEqual([20, 30]);
    useStudio.getState().undo();
    expect(anns()[0].geometry).toEqual(a.geometry);
    sync();
    drag(t, ctx, [[100, 100], [140, 150]]);
    expect((anns()[0].geometry as { points: Pt[] }).points[2]).toEqual([140, 150]);
  });

  it("clicking an edge inserts a vertex; Alt-clicking a vertex deletes it", () => {
    const { ctx, sync } = makeCtx();
    add(square(0, 0));
    sync();
    const t = selectTool();
    click(t, ctx, 50, 50);
    sync();
    click(t, ctx, 50, 0);
    expect((anns()[0].geometry as { points: Pt[] }).points).toEqual([[0, 0], [50, 0], [100, 0], [100, 100], [0, 100]]);
    sync();
    click(t, ctx, 50, 0, { alt: true });
    expect((anns()[0].geometry as { points: Pt[] }).points).toHaveLength(4);
  });

  it("group move updates every selected object in one batch; Shift-drag on empty canvas selects by area", () => {
    const { ctx, sync } = makeCtx();
    const a = add(square(0, 0)), b = add(square(200, 0)), c = add({ type: "keypoint", x: 500, y: 500 });
    sync();
    const t = selectTool();
    expect(drag(t, ctx, [[-10, -10], [350, 150]], { shift: true })).toBe("claim");
    expect(useStudio.getState().selectedIds.sort()).toEqual([a.id, b.id].sort());
    const past = useStudio.getState().past.length;
    drag(t, ctx, [[50, 50], [60, 50], [70, 50]]);
    expect(useStudio.getState().past.length).toBe(past + 1);
    expect(anns().find((x) => x.id === b.id)!.geometry).toMatchObject({ points: [[220, 0], [320, 0], [320, 100], [220, 100]] });
    expect(anns().find((x) => x.id === c.id)!.geometry).toEqual(c.geometry);
  });

  it("locked objects are selectable but not editable (the press passes through to pan)", () => {
    const { ctx, sync } = makeCtx();
    const a = add(square(0, 0));
    useStudio.getState().toggleLabelLocked("tumor");
    sync();
    const t = selectTool();
    expect(t.down(at(ctx, 50, 50), ctx)).toBe("pass");
    expect(useStudio.getState().selectedId).toBe(a.id);
    expect(t.draft()).toBeNull();
  });
});

describe("brush / eraser", () => {
  it("a stroke from inside the selected region grows it; elsewhere it makes a new region; the eraser cuts a hole", () => {
    const { ctx, sync } = makeCtx();
    useStudio.getState().setToolOption("brush", "size", 20);
    useStudio.getState().setTool("brush");
    const brush = brushTool(false);
    drag(brush, ctx, [[0, 0], [10, 0]]); // radius 5 image px at 2×
    const first = anns()[0];
    expect(regionArea(regionOf(first.geometry)!)).toBe(20 * 10);
    useStudio.getState().select(first.id);
    sync();
    drag(brush, ctx, [[5, 0], [40, 0]]);
    expect(anns()).toHaveLength(1);
    expect(regionArea(regionOf(anns()[0].geometry)!)).toBe(50 * 10);
    useStudio.getState().select(null);
    drag(brush, ctx, [[200, 200], [210, 200]]);
    expect(anns()).toHaveLength(2);

    useStudio.getState().select(first.id);
    sync();
    useStudio.getState().setTool("eraser");
    useStudio.getState().setToolOption("eraser", "size", 16);
    const eraser = brushTool(true);
    expect(eraser.ring!(ctx)).toEqual({ radius: 8, erase: true });
    drag(eraser, ctx, [[20, 0], [20, 0]]);
    const g = anns().find((a) => a.id === first.id)!.geometry;
    expect(regionArea(regionOf(g)!)).toBeLessThan(50 * 10);
  });

  it("erasing without a selection cuts every overlapping region of the active label, as one undo step", () => {
    const { ctx, sync } = makeCtx();
    const box = (x: number): Geometry => ({ type: "box", x, y: 0, w: 40, h: 40 });
    add(box(0)), add(box(100)), add(box(200), "stroma");
    sync();
    const past = useStudio.getState().past.length;
    useStudio.getState().setTool("eraser");
    drag(brushTool(true), ctx, [[-20, 20], [300, 20]]);
    const types = anns().map((a) => `${a.label}:${a.geometry.type}`);
    expect(types).toEqual(["tumor:multipolygon", "tumor:multipolygon", "stroma:box"]);
    expect(useStudio.getState().past.length).toBe(past + 1);
  });
});
