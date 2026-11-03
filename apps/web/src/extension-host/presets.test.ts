import { describe, expect, it } from "vitest";
import { MODULES, presets } from "@/extension-host/bundled";
import { labelGroupsFrom, normalizeProject } from "@/studio/lib/api";
import { registry } from "./registry";
import { resolveEnvironment } from "./resolve";
import { ns } from "@studio/contracts/naming";

const PRESETS = ["image-2d", "volume-3d", "ecg", "video", "cine-4d", "pathology"];

describe("bundled presets", () => {
  it("registers every module", () => {
    expect(registry.listModules().map((m) => m.id)).toEqual(MODULES.map((m) => m.id));
    expect(presets.contributes.presets!.map((p) => p.id)).toEqual(expect.arrayContaining(PRESETS));
  });

  it.each(PRESETS)("preset:%s resolves with zero errors", (id) => {
    const r = resolveEnvironment({ extends: `preset:${id}`, labels: labelGroupsFrom(["a", "b"], "classification") }, registry);
    expect(r.errors).toBeUndefined();
    expect(r.env!.tools[0].name).toBe("select");
    expect(r.env!.panels.left.map((p) => p.name)).toEqual(["files", "labels"]);
  });

  it("a Studio extending every preset keeps one profile per kind, the first preset's view as the shorthand (todo19 D4)", () => {
    const r = resolveEnvironment({ extends: ["preset:volume-3d", "preset:cine-4d", "preset:image-2d", "preset:ecg", "preset:video", "preset:pathology"] }, registry);
    expect(r.errors).toBeUndefined();
    const env = r.env!;
    expect(env.dataKind.id).toBe(ns("volume.dataKinds.volume"));
    expect(env.viewports[0].renderer.id).toBe(ns("volume.renderers.cornerstone-mpr"));
    const renderers = Object.fromEntries(Object.entries(env.spec.data?.kinds ?? {}).map(([k, v]) => [k, v.renderer]));
    expect(renderers).toEqual({
      [ns("volume.dataKinds.volume")]: ns("volume.renderers.cornerstone-mpr"),
      [ns("cine.dataKinds.volume-time")]: ns("cine.renderers.slice-frame-canvas"),
      [ns("image2d.dataKinds.raster")]: ns("image2d.renderers.cornerstone-stack"),
      [ns("timeseries.dataKinds.multichannel-timeseries")]: ns("timeseries.renderers.strip-chart"),
      [ns("video.dataKinds.video")]: ns("video.renderers.frame-canvas"),
      [ns("wsi.dataKinds.raster-pyramid")]: ns("wsi.renderers.osd"),
    });
  });

  it("drops the Studio's Review tab from every preset but keeps the panel registered (todo8 D2)", () => {
    for (const p of presets.contributes.presets!) {
      const left = resolveEnvironment({ extends: `preset:${p.id}` }, registry).env?.panels.left.map((x) => x.name) ?? [];
      expect(left, p.id).not.toContain("review");
    }
    // Stored environments may still list it: it resolves, titled "All annotations".
    const r = resolveEnvironment({ extends: "preset:image-2d", panels: { left: [ns("core.panels.files"), ns("core.panels.labels"), ns("core.panels.review")] } }, registry);
    expect(r.errors).toBeUndefined();
    expect(r.env!.panels.left.map((x) => x.title)).toEqual(["Items", "Labels", "All annotations"]);
  });

  it("migrates v1 manifest projects to environments", () => {
    const p = normalizeProject({ id: "x", title: "X", viewer: "signal", task: "event-marking", labels: ["P wave"], source: "", license: "", status: "available", assets: [] });
    expect(p.environment.extends).toBe("preset:ecg");
    expect(p.labels).toEqual([{ name: "labels", control: "Labels", classes: [{ id: "P wave" }] }]);
    expect(resolveEnvironment(p.environment, registry).errors).toBeUndefined();
  });

  it("keeps today's toolbars", () => {
    const tools = (id: string) => resolveEnvironment({ extends: `preset:${id}` }, registry).env!.tools.map((t) => t.name);
    expect(tools("pathology")).toEqual(["select", "pan", "box", "ellipse", "polygon", "freehand", "polyline", "brush", "eraser", "wand", "mark", "length"]);
    expect(tools("ecg")).toEqual(["select", "pan", "interval", "beat", "wave", "rhythm", "caliper"]);
    expect(tools("video")).toEqual(["select", "pan", "box", "polygon", "keypoint", "segment", "event"]);
    expect(tools("cine-4d")).toEqual(["select", "pan", "windowLevel", "spline", "polygon", "freehand", "brush", "eraser"]);
  });
});

describe("non-medical presets (environment JSON only)", () => {
  it.each(["satellite-tiles", "drone-video-tracks", "sensor-timeseries-events", "generic-image"])("preset:%s resolves with zero errors", (id) => {
    const r = resolveEnvironment({ extends: `preset:${id}` }, registry);
    expect(r.errors).toBeUndefined();
  });
});

/** todo8 D4 Rule 1: the task's label groups decide which tools exist. */
describe("usable tools (Rule 1)", () => {
  const resolve = (id: string, labels?: ReturnType<typeof labelGroupsFrom>) => resolveEnvironment({ extends: `preset:${id}`, ...(labels ? { labels } : {}) }, registry).env!;
  const names = (env: ReturnType<typeof resolve>) => env.tools.map((t) => t.name);
  const CLASSIFICATION = labelGroupsFrom(["a", "b"], "classification");
  const REGIONS = labelGroupsFrom(["a", "b"]);

  it.each([
    ["image-2d", "select,pan,zoom,windowLevel,length,angle,cobb,bidirectional,probe,arrow"],
    ["volume-3d", "select,pan,zoom,windowLevel,crosshairs,length,angle,bidirectional,probe,arrow"],
    // The ECG preset keeps its own region "labels" group, so its time tools stay.
    ["ecg", "select,pan,interval,beat,wave,rhythm,caliper"],
    ["video", "select,pan"],
    ["cine-4d", "select,pan,windowLevel"],
    ["pathology", "select,pan,length"],
    ["generic-image", "select,pan"],
  ])("preset:%s for a classification task keeps navigation and measurement only", (id, expected) => {
    expect(names(resolve(id, CLASSIFICATION)).join(",")).toBe(expected);
  });

  it.each([
    ["image-2d", "select,pan,zoom,windowLevel,box,ellipse,polygon,freehand,keypoint,length,angle,cobb,bidirectional,probe,arrow,brush,eraser,wand"],
    ["volume-3d", "select,pan,zoom,windowLevel,crosshairs,brush,eraser,wand,point,length,angle,bidirectional,ellipse,box,polygon,freehand,probe,arrow"],
    ["video", "select,pan,box,polygon,keypoint,segment,event"],
    ["pathology", "select,pan,box,ellipse,polygon,freehand,polyline,brush,eraser,wand,mark,length"],
  ])("preset:%s with a region Labels group keeps every tool", (id, expected) => {
    const env = resolve(id, REGIONS);
    expect(names(env).join(",")).toBe(expected);
    expect(env.unusableTools).toEqual([]);
  });

  it("explains each dropped tool in plain words", () => {
    const env = resolve("image-2d", CLASSIFICATION);
    expect(env.unusableTools.map((u) => [u.tool.name, u.reason])).toEqual([
      ["box", "No label accepts boxes"],
      ["ellipse", "No label accepts ellipses"],
      ["polygon", "No label accepts polygons"],
      ["freehand", "No label accepts polygons"],
      ["keypoint", "No label accepts points"],
      ["brush", "No label accepts masks"],
      ["eraser", "No label accepts masks"],
      ["wand", "No label accepts masks"],
    ]);
  });

  it("keeps Cornerstone ROIs for the shape their label control accepts", () => {
    const env = resolve("image-2d", [{ name: "boxes", control: "RectangleLabels", classes: [{ id: "a" }] }]);
    expect(names(env)).toContain("box");
    expect(names(env)).not.toContain("ellipse");
    expect(names(env)).not.toContain("brush");
  });

  it("applies per preset vocabulary (satellite: polygons and points, no boxes)", () => {
    const env = resolve("satellite-tiles");
    expect(names(env)).not.toContain("box");
    expect(env.unusableTools.map((u) => u.reason)).toEqual(["No label accepts boxes"]);
  });

  it("leaves bare presets (no label groups) untouched, and the catalogue lists every tool", () => {
    expect(resolve("image-2d").unusableTools).toEqual([]);
    expect(registry.list("tools").some((t) => t.name === "brush")).toBe(true);
  });

  it("frees the hotkeys of dropped tools", () => {
    const env = resolve("image-2d", CLASSIFICATION);
    expect(env.tools.some((t) => t.hotkey === "b")).toBe(false);
  });
});
