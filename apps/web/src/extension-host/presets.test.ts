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
