import assert from "node:assert/strict";
import { test } from "node:test";
import { studioKinds } from "../../src/profiles.ts";

const ECG = "studio.timeseries.dataKinds.multichannel-timeseries";
const RASTER = "studio.image2d.dataKinds.raster";

test("studioKinds summarises data.kinds and accepts (todo19 D12)", () => {
  const r = studioKinds({ accepts: [RASTER, ECG], data: { kinds: { [ECG]: { renderer: "studio.timeseries.renderers.strip-chart", profile: "preset:ecg", config: { leads: 12 } } } } });
  assert.deepEqual(r, { accepts: [RASTER, ECG], kinds: { [ECG]: { renderer: "studio.timeseries.renderers.strip-chart", profile: "preset:ecg" } } });
});

test("the one-kind shorthand (data.kind + viewports) reads as one profile", () => {
  const r = studioKinds({ data: { kind: RASTER }, viewports: [{ name: "main", renderer: "studio.image2d.renderers.canvas-raster" }] });
  assert.deepEqual(r, { accepts: [RASTER], kinds: { [RASTER]: { renderer: "studio.image2d.renderers.canvas-raster" } } });
});

test("nothing mapped: empty", () => {
  assert.deepEqual(studioKinds(undefined), { accepts: [], kinds: {} });
});
