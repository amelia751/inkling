import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeAtr, encodeAtr, parseHeader, ustar } from "@studio/renderers/io/wfdb";
import { applyFilters, panTompkins, snapToExtremum, wavePeak } from "./dsp";

/** The former node self-test of the ECG viewer (selftest.mjs), as unit tests. */
const fs = 500;
const N = 10 * fs;
const sine = (f: number, a = 1) => Float64Array.from({ length: N }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / fs));
/** RMS over the middle 6 s, away from the record edges. */
const rms = (x: ArrayLike<number>) => {
  let s = 0;
  for (let i = 2 * fs; i < N - 2 * fs; i++) s += x[i] * x[i];
  return Math.sqrt(s / (N - 4 * fs));
};
const ref = rms(sine(1));

describe("display filters", () => {
  it("high-pass 0.5 Hz removes a 0.2 Hz sinusoid; 0.05 Hz keeps it", () => {
    expect(rms(applyFilters(sine(0.2), fs, { hp: 0.5, notch: 0, lp: 0 })) / ref).toBeLessThan(0.2);
    expect(rms(applyFilters(sine(0.2), fs, { hp: 0.05, notch: 0, lp: 0 })) / ref).toBeGreaterThan(0.9);
  });
  it("notch removes mains, low-pass removes EMG-band noise, both keep 10 Hz", () => {
    expect(rms(applyFilters(sine(50), fs, { hp: 0, notch: 50, lp: 0 })) / ref).toBeLessThan(0.1);
    expect(rms(applyFilters(sine(120), fs, { hp: 0, notch: 0, lp: 40 })) / ref).toBeLessThan(0.1);
    expect(rms(applyFilters(sine(10), fs, { hp: 0.5, notch: 50, lp: 40 })) / ref).toBeGreaterThan(0.9);
  });
  it("is zero-phase: a filtered 10 Hz sine stays aligned", () => {
    const x = sine(10);
    const y = applyFilters(x, fs, { hp: 0.5, notch: 50, lp: 40 });
    let best = 0;
    let lag = 0;
    for (let k = -10; k <= 10; k++) {
      let s = 0;
      for (let i = 2 * fs; i < N - 2 * fs; i++) s += x[i] * y[i + k];
      if (s > best) [best, lag] = [s, k];
    }
    expect(lag).toBe(0);
  });
});

/** Synthetic ECG-like trace: narrow R spikes, a broad T wave, baseline wander and noise. */
function synthetic(beats: number[]) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.04;
  return Float64Array.from({ length: N }, (_, i) => {
    const t = i / fs;
    let v = 0.15 * Math.sin(2 * Math.PI * 0.3 * t) + rand();
    for (const b of beats) v += 1.2 * Math.exp(-(((t - b) / 0.012) ** 2)) + 0.3 * Math.exp(-(((t - b - 0.28) / 0.05) ** 2));
    return v;
  });
}

describe("Pan–Tompkins", () => {
  it("finds every R peak of a synthetic trace within 10 ms and not the T waves", () => {
    const beats = [0.6, 1.45, 2.3, 3.2, 4.05, 4.9, 5.8, 6.65, 7.5, 8.4, 9.25];
    const { peaks } = panTompkins(synthetic(beats), fs);
    expect(peaks.length).toBe(beats.length);
    peaks.forEach((p, i) => expect(Math.abs(p / fs - beats[i])).toBeLessThan(0.01));
  });
  it("snaps to the local extremum and finds a wave's peak", () => {
    const x = synthetic([2]);
    expect(snapToExtremum(x, fs, 2.03)).toBeCloseTo(2, 2);
    expect(wavePeak(x, fs, 1.95, 2.06)).toBeCloseTo(2, 2);
  });
  const seed = join(__dirname, "../../../seed-data/ecg-waveform");
  it.skipIf(!existsSync(seed))("detects a plausible heart rate on every seeded PTB-XL record", () => {
    for (const f of readdirSync(seed).filter((n) => /^HR\d+\.json$/.test(n))) {
      const rec = JSON.parse(readFileSync(join(seed, f), "utf8")) as { fs: number; samples: number; leads: Record<string, number[]> };
      const { peaks } = panTompkins(rec.leads.II, rec.fs);
      const hr = (60 * (peaks.length - 1)) / ((peaks[peaks.length - 1] - peaks[0]) / rec.fs);
      expect(hr, f).toBeGreaterThan(30);
      expect(hr, f).toBeLessThan(200);
    }
  });
});

describe("WFDB writers (kits/io/wfdb)", () => {
  it("round-trips .atr with SKIP, AUX, CHN and SUB; ustar pads to 512", () => {
    const anns = [
      { sample: 10, code: 28, aux: "(N" },
      { sample: 250, code: 1, chan: 0 },
      { sample: 700, code: 5, chan: 1 },
      { sample: 5700, code: 1, chan: 1 },
      { sample: 9000, code: 28, aux: "(AFIB" },
      { sample: 9100, code: 14, sub: -1 },
    ];
    const back = decodeAtr(encodeAtr(anns));
    expect(back.map((a) => [a.sample, a.code, a.aux ?? "", a.sub ?? 0])).toEqual(anns.map((a) => [a.sample, a.code, a.aux ?? "", a.sub ?? 0]));
    expect(back.map((a) => a.chan)).toEqual([0, 0, 1, 1, 1, 1]);
    expect(ustar([{ name: "R.atr", data: new Uint8Array(3) }]).length % 512).toBe(0);
  });
  it("parses a header's record line and signal names", () => {
    expect(parseHeader("R1 2 250 1000\nR1.mat 16 200 16 0 0 0 0 I\nR1.mat 16 200 16 0 0 0 0 aVR\n#c\n")).toEqual({ record: "R1", nsig: 2, fs: 250, samples: 1000, signals: ["I", "aVR"] });
  });
});
