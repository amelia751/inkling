import { describe, expect, it } from "vitest";
import { registry } from "./registry";
import { profileForItem, resolveEnvironment } from "./resolve";
import { FILE_VIEW_RENDERER } from "@studio/plugin-ui-sdk/resolved";
import "@/extension-host/bundled";

const RASTER = "studio.image2d.dataKinds.raster";
const ECG = "studio.timeseries.dataKinds.multichannel-timeseries";
const CANVAS = "studio.image2d.renderers.canvas-raster";
const STRIP = "studio.timeseries.renderers.strip-chart";

describe("resolver profiles (todo19 D3)", () => {
  it("resolves every data.kinds profile and keeps the one-kind fields", () => {
    const r = resolveEnvironment({ data: { kinds: { [RASTER]: { renderer: CANVAS }, [ECG]: { renderer: STRIP, profile: "preset:ecg" } } } }, registry);
    expect(r.errors).toBeUndefined();
    const env = r.env!;
    expect(Object.keys(env.profiles).sort()).toEqual([ECG, RASTER].sort());
    expect(env.profiles[ECG].viewports[0].renderer.id).toBe(STRIP);
    expect(env.profiles[ECG].id).toBe("preset:ecg");
    expect(env.profiles[ECG].context["item.kind"]).toBe(ECG);
    expect(env.profiles[ECG].context["item.profile"]).toBe("preset:ecg");
    expect(env.dataKind.id).toBe(RASTER);
    expect(env.viewports[0].renderer.id).toBe(CANVAS);
  });

  it("the one-kind shorthand becomes one profile", () => {
    const env = resolveEnvironment({ extends: "preset:ecg" }, registry).env!;
    expect(Object.keys(env.profiles)).toEqual([ECG]);
    expect(env.profiles[ECG].viewports.map((v) => v.renderer.id)).toEqual(env.viewports.map((v) => v.renderer.id));
  });

  it("rejects a profile whose renderer doesn't consume its kind, naming the kind", () => {
    const r = resolveEnvironment({ data: { kinds: { [RASTER]: { renderer: CANVAS }, [ECG]: { renderer: CANVAS } } } }, registry);
    const e = r.errors?.find((x) => x.code === "renderer-data-mismatch");
    expect(e?.path).toBe(`/data/kinds/${ECG}/renderer`);
    expect(e?.message).toContain(ECG);
    expect(e?.suggestion).toBe(STRIP);
  });

  it("picks the item's profile, else the file view", () => {
    const env = resolveEnvironment({ data: { kinds: { [RASTER]: { renderer: CANVAS } } } }, registry).env!;
    expect(profileForItem(env, { dataKind: RASTER })?.viewports[0].renderer.id).toBe(CANVAS);
    expect(profileForItem(env, { dataKind: "studio.wsi.dataKinds.raster-pyramid" })).toBeUndefined();
    expect(env.fileView?.renderer.id).toBe(FILE_VIEW_RENDERER);
  });
});
