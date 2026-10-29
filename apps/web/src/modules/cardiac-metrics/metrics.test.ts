import { describe, expect, it } from "vitest";
import type { FrameMetrics, StructKey } from "@/modules/cine/public";
import { computeMetrics, mosteller } from "./metrics";

const frame = (f: number, lv: number | null, rv: number | null, myo: number | null): FrameMetrics => {
  const status = (v: number | null) => (v === null ? "empty" : "complete");
  return {
    frame: f,
    areas: new Map(),
    volume: { lv, rv, myo } as Record<StructKey, number | null>,
    status: { lv: status(lv), rv: status(rv), myo: status(myo) },
    missing: { lv: [], rv: [], myo: [] },
  };
};

describe("inkling.cardiac-metrics", () => {
  const frames = [frame(0, 120, 130, 80), frame(1, 90, 100, null), frame(2, 50, 60, 76)];

  it("computes EDV/ESV/SV/EF and LV mass", () => {
    const m = computeMetrics({ frames, ed: 0, es: 2, bsa: 2 });
    expect(m.lv).toEqual({ edv: 120, esv: 50, sv: 70, ef: (70 / 120) * 100 });
    expect(m.rv.sv).toBe(70);
    expect(m.mass).toBeCloseTo(84);
    expect(m.massEs).toBeCloseTo(79.8);
    expect(m.warnings).toEqual([]);
    expect(m.suggested).toEqual({ ed: 0, es: 2 }); // agrees with the marked ED / ES
  });

  it("suggests ED / ES from the LV curve and warns about missing phases", () => {
    const m = computeMetrics({ frames, ed: 1, es: null, bsa: null });
    expect(m.suggested).toEqual({ ed: 0, es: 2 });
    expect(m.warnings[0]).toMatch(/Mark both ED and ES/);
    expect(m.lv.ef).toBeNull();
  });

  it("Mosteller BSA", () => {
    expect(mosteller(180, 80)).toBeCloseTo(2);
    expect(mosteller(null, 80)).toBeNull();
  });
});
