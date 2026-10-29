import { describe, expect, it } from "vitest";
import { MODULES, presets } from "@/bundle";
import { labelGroupsFrom, normalizeProject } from "@/lib/api";
import { registry } from "./registry";
import { resolveEnvironment } from "./resolve";

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
    expect(r.env!.panels.left.map((p) => p.name)).toEqual(["files", "labels", "review"]);
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
  it.each(["satellite-tiles", "drone-video-tracks"])("preset:%s resolves with zero errors", (id) => {
    const r = resolveEnvironment({ extends: `preset:${id}` }, registry);
    expect(r.errors).toBeUndefined();
  });
});
