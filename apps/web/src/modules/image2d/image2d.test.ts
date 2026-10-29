import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/bundle";
import { labelGroupsFrom } from "@/lib/api";
import { registry } from "@/platform/registry";
import { resolveEnvironment } from "@/platform/resolve";
import type { Annotation, Geometry, Project, Pt, StudioItem } from "@/types";
import { cocoExporter } from "./exporters";
import { fitCamera, panBy, toImage, toScreen, zoomAbout, type Camera } from "./renderer/canvas/camera";
import { RasterEditor, roundGeometry, type EditorEnv } from "./renderer/canvas/editor";
import { StackConfigSchema } from "./view";

// ---------------------------------------------------------------- camera

describe("canvas-raster camera", () => {
  it("fits the image centred with a margin", () => {
    const c = fitCamera(200, 100, 1000, 1000, 1);
    expect(c.scale).toBe(5);
    expect(toScreen(c, 0, 0)).toEqual([0, 250]);
    expect(toScreen(c, 200, 100)).toEqual([1000, 750]);
  });

  it("round-trips image ↔ screen and zooms about the cursor", () => {
    const c: Camera = { scale: 2, tx: 10, ty: -4 };
    expect(toImage(c, ...toScreen(c, 33, 44))).toEqual([33, 44]);
    const z = zoomAbout(c, 1.5, 300, 200);
    expect(z.scale).toBe(3);
    const before = toImage(c, 300, 200), after = toImage(z, 300, 200);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  it("clamps zoom relative to the fit scale and pans in screen pixels", () => {
    expect(zoomAbout({ scale: 1, tx: 0, ty: 0 }, 1e6, 0, 0, 1).scale).toBe(64);
    expect(zoomAbout({ scale: 1, tx: 0, ty: 0 }, 1e-6, 0, 0, 1).scale).toBe(1 / 64);
    expect(panBy({ scale: 2, tx: 1, ty: 2 }, 10, -5)).toEqual({ scale: 2, tx: 11, ty: -3 });
  });
});

// ---------------------------------------------------------------- editor

function harness(initial: Annotation[] = [], camera: Camera = { scale: 2, tx: 0, ty: 0 }) {
  let annotations = initial;
  let selected: string[] = [];
  const created: Geometry[] = [];
  const commits: { id: string; geometry: Geometry }[][] = [];
  const env: EditorEnv = {
    annotations: () => annotations,
    selectedIds: () => selected,
    editable: (a) => !a.locked,
    toScreen: (x, y) => toScreen(camera, x, y),
    toImage: (sx, sy) => toImage(camera, sx, sy),
    size: () => [500, 400],
    select: (id) => (selected = id ? [id] : []),
    toggle: (id) => (selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]),
    create: (g) => created.push(g),
    commit: (c) => {
      commits.push(c);
      annotations = annotations.map((a) => ({ ...a, geometry: c.find((x) => x.id === a.id)?.geometry ?? a.geometry }));
    },
    pan: (dx, dy) => Object.assign(camera, panBy(camera, dx, dy)),
  };
  const ed = new RasterEditor(env);
  /** Screen point of an image point. */
  const s = (x: number, y: number): Pt => toScreen(camera, x, y);
  return { ed, env, s, created, commits, camera, selected: () => selected };
}

const ann = (id: string, geometry: Geometry, extra: Partial<Annotation> = {}): Annotation => ({
  id,
  itemId: "img",
  label: "a",
  geometry,
  provenance: "human-created",
  author: "t",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

describe("canvas-raster editor", () => {
  it("draws a box in image pixels, normalised and rounded; ignores clicks", () => {
    const { ed, s, created } = harness();
    ed.down("box", s(30, 40));
    ed.move(s(10.123, 90));
    ed.up(s(10.123, 90));
    expect(created).toEqual([{ type: "box", x: 10.12, y: 40, w: 19.88, h: 50 }]);
    ed.down("box", s(5, 5));
    ed.up(s(5.5, 5.5));
    expect(created).toHaveLength(1);
  });

  it("clamps drawn shapes to the image", () => {
    const { ed, s, created } = harness();
    ed.down("box", s(480, 380));
    ed.up(s(600, 450));
    expect(created[0]).toEqual({ type: "box", x: 480, y: 380, w: 20, h: 20 });
  });

  it("draws a polygon: click vertices, close on the first, Backspace / Escape / Enter", () => {
    const { ed, s, created } = harness();
    for (const p of [[10, 10], [100, 10], [100, 100]] as Pt[]) ed.down("polygon", s(...p));
    ed.down("polygon", s(200, 200));
    expect(ed.removeLastVertex()).toBe(true);
    ed.down("polygon", s(10.5, 10.5)); // within CLOSE_RADIUS of the first vertex
    expect(created).toEqual([{ type: "polygon", points: [[10, 10], [100, 10], [100, 100]] }]);
    expect(ed.draft).toBeNull();

    ed.down("polygon", s(1, 1));
    ed.down("polygon", s(50, 1));
    expect(ed.cancel()).toBe(true);
    expect(ed.cancel()).toBe(false);
    expect(ed.finish()).toBe(false);

    for (const p of [[1, 1], [50, 1], [50, 50]] as Pt[]) ed.down("polygon", s(...p));
    expect(ed.finish()).toBe(true);
    expect(created).toHaveLength(2);
  });

  it("places keypoints", () => {
    const { ed, s, created } = harness();
    ed.down("keypoint", s(12.345, 67.891));
    expect(created).toEqual([{ type: "keypoint", x: 12.35, y: 67.89 }]);
  });

  it("selects, moves (one commit) and resizes by handle", () => {
    const { ed, s, commits, selected } = harness([ann("b", { type: "box", x: 10, y: 10, w: 20, h: 20 })]);
    ed.down("select", s(20, 20));
    expect(selected()).toEqual(["b"]);
    ed.move(s(25, 30));
    ed.up(s(25, 30));
    expect(commits).toEqual([[{ id: "b", geometry: { type: "box", x: 15, y: 20, w: 20, h: 20 } }]]);
    // Bottom-right handle (index 4) of the moved box.
    ed.down("select", s(35, 40));
    ed.up(s(45, 50));
    expect(commits[1]).toEqual([{ id: "b", geometry: { type: "box", x: 15, y: 20, w: 30, h: 30 } }]);
  });

  it("a click without a drag commits nothing; empty clicks deselect; shift toggles", () => {
    const { ed, s, commits, selected } = harness([ann("b", { type: "box", x: 10, y: 10, w: 20, h: 20 }), ann("k", { type: "keypoint", x: 100, y: 100 })]);
    ed.down("select", s(20, 20));
    ed.up(s(20, 20));
    expect(commits).toHaveLength(0);
    ed.down("select", s(100, 100), { shift: true });
    expect(selected()).toEqual(["b", "k"]);
    ed.down("select", s(300, 300));
    expect(selected()).toEqual([]);
  });

  it("keeps moved shapes inside the image and never moves locked ones", () => {
    const { ed, s, commits } = harness([ann("b", { type: "box", x: 10, y: 10, w: 20, h: 20 }), ann("l", { type: "box", x: 200, y: 200, w: 10, h: 10 }, { locked: true })]);
    ed.down("select", s(20, 20));
    ed.up(s(-100, 20));
    expect(commits[0]).toEqual([{ id: "b", geometry: { type: "box", x: 0, y: 10, w: 20, h: 20 } }]);
    ed.down("select", s(205, 205));
    ed.up(s(250, 250));
    expect(commits).toHaveLength(1);
  });

  it("pans with the pan tool or when forced (Space, middle button)", () => {
    const { ed, s, camera, created } = harness();
    ed.down("box", [100, 100], {}, true);
    ed.move([130, 90]);
    ed.up([130, 90]);
    expect(camera).toMatchObject({ tx: 30, ty: -10 });
    expect(created).toHaveLength(0);
    void s;
  });

  it("rounds geometries to 0.01 px", () => {
    expect(roundGeometry({ type: "polygon", points: [[1.234, 5.678]] })).toEqual({ type: "polygon", points: [[1.23, 5.68]] });
  });
});

// ---------------------------------------------------------------- manifest, presets, config

describe("image2d module", () => {
  it("preset:generic-image resolves to canvas-raster with overlay2d tools and COCO, without Cornerstone keys", () => {
    const r = resolveEnvironment({ extends: "preset:generic-image", labels: labelGroupsFrom(["a", "b"]) }, registry);
    expect(r.errors).toBeUndefined();
    const env = r.env!;
    expect(env.viewports[0].renderer.id).toBe("inkling.image2d.renderers.canvas-raster");
    expect(env.tools.map((t) => t.id)).toEqual(["inkling.core.tools.select", "inkling.core.tools.pan", "inkling.overlay2d.tools.box", "inkling.overlay2d.tools.polygon", "inkling.overlay2d.tools.keypoint"]);
    expect(env.tools.map((t) => t.creates)).toEqual([undefined, undefined, "box", "polygon", "keypoint"]);
    expect(env.exporters.map((e) => e.id)).toEqual(["inkling.image2d.exporters.coco"]);
    const commands = env.commands.map((c) => c.id);
    expect(commands).toEqual(expect.arrayContaining(["inkling.image2d.commands.fitView", "inkling.core.commands.finishShape", "inkling.core.commands.cancelShape", "inkling.core.commands.removeLastVertex", "inkling.core.commands.holdToPan"]));
    expect(commands.filter((c) => c.startsWith("inkling.cornerstone.") || c === "inkling.image2d.commands.cancelManipulation")).toEqual([]);
    expect(env.spec.overrides).toEqual([{ id: "inkling.cornerstone.tools.cobb", disabled: true }]);
  });

  it("preset:image-2d keeps cobb, binds the stack's view keys and puts the view controls in the viewport bar", () => {
    const env = resolveEnvironment({ extends: "preset:image-2d" }, registry).env!;
    expect(env.tools.map((t) => t.name)).toContain("cobb");
    expect(env.panels["viewport-bar"].map((p) => p.id)).toEqual(["inkling.image2d.panels.viewControls"]);
    const keys = Object.fromEntries(env.commands.map((c) => [c.id, c.keys]));
    expect(keys["inkling.image2d.commands.fitView"]).toEqual(["0", "="]);
    expect(keys["inkling.cornerstone.commands.invertImage"]).toEqual(["shift+i"]);
    expect(keys["inkling.core.commands.rotateView"]).toEqual(["shift+r"]);
    expect(keys["inkling.image2d.commands.cancelManipulation"]).toEqual(["Escape"]);
  });

  it("stack config defaults every control on and validates overrides", () => {
    const d = StackConfigSchema.parse({});
    expect([d.windowLevel, d.invert, d.flip, d.rotate, d.colormap, d.interpolation, d.magnifier]).toEqual([true, true, true, true, true, true, true]);
    expect(d.ctPresets.map((p) => p.id)).toContain("lung");
    const r = resolveEnvironment({ extends: "preset:image-2d", viewports: [{ name: "main", renderer: "inkling.image2d.renderers.cornerstone-stack", config: { windowLevel: false } }] }, registry);
    expect(r.env!.viewports[0].config.windowLevel).toBe(false);
    const bad = resolveEnvironment({ extends: "preset:image-2d", viewports: [{ name: "main", renderer: "inkling.image2d.renderers.cornerstone-stack", config: { invert: "no" } }] }, registry);
    expect(bad.errors?.[0].code).toBe("invalid-config");
  });
});

// ---------------------------------------------------------------- COCO

describe("COCO exporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("writes boxes, polygons, keypoints, measurements and item classes in COCO form", async () => {
    const project = { id: "p", title: "P", license: "CC0", labels: labelGroupsFrom(["cat", "dog"]), assets: [] } as unknown as Project;
    const items: StudioItem[] = [{ id: "a.png", name: "a.png", group: "Images", assets: [{ path: "a.png", sha256: "", bytes: 0, width: 640, height: 480 }] }];
    const annotations: Annotation[] = [
      ann("1", { type: "box", x: 10.004, y: 20, w: 30, h: 40 }, { itemId: "a.png", label: "cat" }),
      ann("2", { type: "polygon", points: [[0, 0], [10, 0], [10, 10]] }, { itemId: "a.png", label: "dog" }),
      ann("3", { type: "keypoint", x: 5, y: 6 }, { itemId: "a.png", label: "cat" }),
      ann("4", { type: "class" }, { itemId: "a.png", label: "dog" }),
      ann("5", { type: "measurement", kind: "length", points: [[0, 0], [3, 4]], space: "image", stats: { length: 5 }, unit: "px" }, { itemId: "a.png", label: "cat" }),
    ];
    const doc = JSON.parse(await (await cocoExporter.build({ project, items, annotations })).text());
    expect(doc).toEqual({
      info: { description: "P", version: "1.0", date_created: "2026-10-29T12:00:00.000Z", contributor: "Inkling" },
      licenses: [{ id: 1, name: "CC0" }],
      images: [{ id: 1, file_name: "a.png", width: 640, height: 480, inkling_class: "dog", inkling_class_id: 2 }],
      categories: [
        { id: 1, name: "cat", supercategory: "p" },
        { id: 2, name: "dog", supercategory: "p" },
      ],
      annotations: [
        { id: 1, image_id: 1, category_id: 1, iscrowd: 0, inkling_id: "1", inkling_provenance: "human-created", bbox: [10, 20, 30, 40], area: 1200, segmentation: [] },
        { id: 2, image_id: 1, category_id: 2, iscrowd: 0, inkling_id: "2", inkling_provenance: "human-created", bbox: [0, 0, 10, 10], area: 50, segmentation: [[0, 0, 10, 0, 10, 10]] },
        { id: 3, image_id: 1, category_id: 1, iscrowd: 0, inkling_id: "3", inkling_provenance: "human-created", keypoints: [5, 6, 2], num_keypoints: 1, bbox: [5, 6, 0, 0], area: 0 },
      ],
      inkling_measurements: [{ image_id: 1, label: "cat", kind: "length", points: [[0, 0], [3, 4]], unit: "px", stats: { length: 5 }, inkling_id: "5" }],
    });
    expect(cocoExporter.filename(project)).toBe("p-coco.json");
  });
});
