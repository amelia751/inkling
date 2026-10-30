import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { migrateAnnotation } from "@studio/plugin-contracts/migrations/annotations-v1-to-v2";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment } from "@/extension-host/resolve";
import { runtimeFor } from "@studio/plugin-ui-sdk/runtime";
import type { InspectFn } from "@studio/plugin-ui-sdk/module";
import type { Annotation } from "@studio/plugin-contracts/types";
import { measurementsConfig, statementsOf, stripConfig } from "./config";
import { describeInstant, describeSpan } from "./geometries";
import { beatTimes, measure } from "./measure";
import * as M from "./model";
import { parseCsv } from "./readers/csv";
import { niceStep } from "./renderer/draw";
import { columnsFor, computeFrame } from "./renderer/layout";
import { ns } from "@studio/plugin-contracts/naming";

const ann = (geometry: unknown, attributes?: Annotation["attributes"], extra: Partial<Annotation> = {}): Annotation =>
  ({ id: Math.random().toString(36), itemId: "x", label: "L", geometry, attributes, provenance: "human-created", author: "me", createdAt: "", ...extra }) as Annotation;

describe("model: the stored v2 form", () => {
  it("constructors write exactly what the v1→v2 migration writes", () => {
    const pairs: [unknown, M.Shape][] = [
      [{ type: "interval", lead: "II", start: 1, end: 2 }, M.interval("II", 1, 2)],
      [{ type: "beat", lead: "all", t: 0.5, code: "V" }, M.beat("all", 0.5, "V")],
      [{ type: "wave", lead: "V1", wave: "QRS", onset: 1, peak: 1.05, offset: 1.1 }, M.wave("V1", "QRS", 1, 1.1, 1.05)],
      [{ type: "wave", lead: "V1", wave: "P", onset: 1, offset: 1.1 }, M.wave("V1", "P", 1, 1.1)],
      [{ type: "rhythm", start: 0, end: 3, rhythm: "(AFIB" }, M.rhythm("rhythm", 0, 3, "(AFIB")],
    ];
    for (const [v1, shape] of pairs) {
      const m = migrateAnnotation(ann(v1));
      expect({ geometry: m.geometry, attributes: m.attributes }).toEqual(shape);
    }
  });
  it("reads kinds, channels and times; strips only migration keys", () => {
    const b = ann(...(Object.values(M.beat("II", 0.7, "N", { source: "pan-tompkins" })) as [unknown, Annotation["attributes"]]));
    expect(M.kindOf(b)).toBe("beat");
    expect(M.channelOf(b.geometry)).toBe("II");
    expect(M.timeOf(b.geometry)).toBe(0.7);
    expect(M.ownAttributes(b)).toEqual({ source: "pan-tompkins" });
    const w = ann({ type: "span", start: 1, end: 2, channel: "V1" }, { kind: "wave", wave: "T", peak: 1.5 });
    expect([M.kindOf(w), M.waveOf(w), M.peakOf(w), M.ownAttributes(w)]).toEqual(["wave", "T", 1.5, undefined]);
    // Spans and instants without a kind: track spans are episodes, others intervals; frame events are not ours.
    expect(M.kindOf(ann({ type: "span", start: 0, end: 1, channel: "rhythm" }))).toBe("rhythm");
    expect(M.kindOf(ann({ type: "span", start: 0, end: 1 }))).toBe("interval");
    expect(M.kindOf(ann({ type: "instant", frame: 3 }))).toBeNull();
    expect(M.kindOf(ann({ type: "box", x: 0, y: 0, w: 1, h: 1 }))).toBeNull();
  });
  it("moves and clears a wave peak in place", () => {
    expect(M.withPeak({ kind: "wave", wave: "QRS", note: "x" }, 1.2)).toEqual({ kind: "wave", wave: "QRS", peak: 1.2, note: "x" });
    expect(Object.keys(M.withPeak({ kind: "wave", wave: "QRS", note: "x" }, 1.2))).toEqual(["kind", "wave", "peak", "note"]);
    expect(M.withPeak({ kind: "wave", wave: "QRS", peak: 1 }, undefined)).toEqual({ kind: "wave", wave: "QRS" });
  });
});

describe("geometries: describe refinements", () => {
  it("describes strip-chart kinds and falls back to the core wording", () => {
    const d = (g: unknown, at?: Annotation["attributes"]) => {
      const a = ann(g, at);
      return a.geometry.type === "span" ? describeSpan(a.geometry, a) : describeInstant(a.geometry, a);
    };
    expect(d({ type: "instant", t: 0.7, channel: "all" }, { kind: "beat", code: "V" })).toBe("Beat V · 0.700s");
    expect(d({ type: "instant", t: 0.7, channel: "II" }, { kind: "beat", code: "N" })).toBe("Beat N · 0.700s · II");
    expect(d({ type: "span", start: 1, end: 1.1, channel: "V1" }, { kind: "wave", wave: "QRS" })).toBe("QRS wave · V1 · 1.000–1.100s");
    expect(d({ type: "span", start: 0, end: 4, channel: "rhythm" }, { kind: "rhythm", rhythm: "(AFIB" })).toBe("Rhythm (AFIB · 0.00–4.00s");
    expect(d({ type: "span", start: 0, end: 1, channel: "II" }, { kind: "interval" })).toBe("II · 0.00–1.00s");
    expect(d({ type: "instant", frame: 2 })).toBe("Event · frame 3");
  });
});

describe("measure", () => {
  it("rate from record-level instants, PR / QT from waves on the same channel", () => {
    const beats = [0.5, 1.5, 2.5].map((t) => ann(M.beat("all", t, "N").geometry, M.beat("all", t, "N").attributes));
    const w = (name: string, a: number, b: number) => ann(M.wave("II", name, a, b).geometry, M.wave("II", name, a, b).attributes);
    const m = measure([...beats, w("P", 0.3, 0.38), w("QRS", 0.46, 0.56), w("T", 0.7, 0.86)]);
    expect(beatTimes(beats)).toEqual([0.5, 1.5, 2.5]);
    expect(m.hr).toBeCloseTo(60);
    expect(m.codes).toEqual([["N", 3]]);
    expect(m.pr).toBeCloseTo(0.16);
    expect(m.qt).toBeCloseTo(0.4);
    expect(m.waves).toEqual({ P: 1, QRS: 1, T: 1 });
  });
});

describe("readers: csv", () => {
  it("reads a time column and numeric channels; fs from the median step", () => {
    const r = parseCsv("time,ax,ay,az\n0,0.1,0,1\n0.01,0.2,0,1\n0.02,0.3,0.1,0.9\n0.03,0.2,0,1\n", { record: "walk" });
    expect(r).toMatchObject({ record: "walk", fs: 100, samples: 4, channels: ["ax", "ay", "az"] });
    expect([...r.data.az]).toEqual([1, 1, Math.fround(0.9), 1]);
  });
  it("milliseconds, semicolons, no header + sampleRate", () => {
    expect(parseCsv("t_ms;x\n0;1\n20;2\n40;3\n", { record: "r" }).fs).toBe(50);
    const r = parseCsv("1,2\n3,4\n", { record: "r", sampleRate: 10 });
    expect([r.fs, r.channels]).toEqual([10, ["ch1", "ch2"]]);
    expect(() => parseCsv("a,b\n1,2\n", { record: "r" })).toThrow(/sampleRate/);
  });
});

describe("renderer layout", () => {
  const ecg = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"];
  it("columns follow the configured order, or even chunks without one", () => {
    expect(columnsFor([...ecg].reverse(), "3x4", "II", ecg)[0]).toEqual(["I", "II", "III"]);
    expect(columnsFor(["a", "b", "c", "d"], "6x2", "a")).toEqual([["a", "b", "c", "d"]]);
    expect(columnsFor(["a", "b"], "single", "b")).toEqual([["b"]]);
  });
  it("3×4 adds a full-width strip only for a configured channel the record has", () => {
    const f = (strip?: string) =>
      computeFrame({ width: 1000, height: 600, leads: ecg, mode: "3x4", focus: "II", scale: "fit", speed: 25, gain: 10, windowSec: 10, offset: 0, duration: 10, order: ecg, stripChannel: strip });
    expect(f("II").panels.filter((p) => p.rhythmStrip).map((p) => p.lead)).toEqual(["II"]);
    expect(f(undefined).panels.some((p) => p.rhythmStrip)).toBe(false);
  });
  it("plain grid steps are 1-2-5", () => {
    expect([niceStep(0.3), niceStep(0.12), niceStep(4), niceStep(1)]).toEqual([0.5, 0.2, 5, 1]);
  });
});

describe("environments", () => {
  it("preset:ecg carries the ECG vocabulary as config and a multiple Choices statements group", () => {
    const env = resolveEnvironment({ extends: "preset:ecg", labels: [{ name: "labels", control: "Labels", classes: [{ id: "P wave" }] }] }, registry).env!;
    const cfg = stripConfig(env);
    expect([cfg.grid, cfg.ecg, cfg.channelNoun, cfg.track.channel, cfg.instantCodes[0].id]).toEqual(["ecg", true, "lead", "rhythm", "N"]);
    expect(cfg.instantCodes.find((c) => c.id === "V")?.hotkey).toBe("shift+v");
    // The project's own "labels" group replaces the preset's; the statements group stays.
    expect(env.labels.map((g) => g.name)).toEqual(["labels", "statements"]);
    const st = statementsOf(env, measurementsConfig(env));
    expect(st.items.find((s) => s.name === "AF")).toEqual({ id: "Atrial fibrillation", name: "AF", code: "164889003" });
    expect(env.panels.right.map((p) => p.id)).toEqual([ns("timeseries.panels.measurements"), ns("core.panels.ai")]);
    expect(env.commands.find((c) => c.id === ns("timeseries.commands.setBeatCode"))?.keys).toContain("shift+n");
  });
  it("a non-ECG timeseries uses the same module with its own classes and a plain grid", () => {
    const r = resolveEnvironment(
      {
        data: { kind: ns("timeseries.dataKinds.multichannel-timeseries") },
        viewports: [{ name: "main", renderer: ns("timeseries.renderers.strip-chart"), config: { reader: "csv", grid: "plain", unit: "g", track: { channel: "activity", label: "Activity" }, trackCodes: [{ id: "walk" }, { id: "run" }] } }],
        tools: [ns("core.tools.select"), ns("timeseries.tools.interval"), ns("timeseries.tools.beat"), ns("timeseries.tools.rhythm")],
        labels: [{ name: "events", control: "TimeSeriesLabels", classes: [{ id: "step" }, { id: "fall" }] }],
        panels: { right: [ns("timeseries.panels.measurements")] },
      },
      registry,
      { baseModules: [ns("core")] },
    );
    expect(r.errors).toBeUndefined();
    const cfg = stripConfig(r.env);
    expect([cfg.grid, cfg.ecg, cfg.instantCodes, cfg.channelNoun]).toEqual(["plain", false, [], "channel"]);
  });
  it("the README environment resolves", () => {
    const md = readFileSync(join(__dirname, "../README.md"), "utf8");
    const spec = JSON.parse(/```json\n([\s\S]*?)```/.exec(md)![1]);
    const r = resolveEnvironment(spec, registry, { baseModules: [ns("core")] });
    expect(r.errors).toBeUndefined();
    expect(stripConfig(r.env).trackCodes.map((c) => c.id)).toEqual(["walk", "run", "rest"]);
  });
  it("the inspector reads fs from runtime.signalInfo and names codes from the config", async () => {
    const env = resolveEnvironment({ extends: "preset:ecg" }, registry).env!;
    const inspect = await registry.loadImpl<InspectFn>(ns("timeseries.inspectors.main"));
    const runtime = runtimeFor("rec");
    runtime.publish("signalInfo", { record: "r", fs: 500, samples: 5000, channels: ["II"] });
    const s = M.beat("all", 0.7, "V");
    const rows = Object.fromEntries(inspect(ann(s.geometry, s.attributes, { provenance: "ai-suggested" }), { env, project: null as never, item: { id: "rec" } as never, runtime }));
    expect(rows).toMatchObject({ Code: "V — Premature ventricular contraction", Time: "0.700 s · #350", Lead: "All leads", Provenance: "AI suggestion · unreviewed" });
  });
});
