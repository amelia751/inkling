// Node self-test for the ECG viewer's DSP and WFDB writers. Run from apps/web:
//   node --experimental-strip-types --no-warnings src/viewers/signal/selftest.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFilters, panTompkins } from "./dsp.ts";
import { encodeAtr, decodeAtr, ustar } from "@/kits/io/wfdb";

const here = dirname(fileURLToPath(import.meta.url));
const seed = join(here, "../../../../../seed-data/ecg-waveform");
let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// ---------------- Filters ----------------
const fs = 500;
const N = 10 * fs;
const sine = (f, a = 1) => Float64Array.from({ length: N }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / fs));
/** RMS over the middle 6 s, away from the record edges. */
const rms = (x) => {
  let s = 0;
  const a = 2 * fs, b = N - 2 * fs;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
};
const ref = rms(sine(1));

{
  const y = applyFilters(sine(0.2), fs, { hp: 0.5, notch: 0, lp: 0 });
  const r = rms(y) / ref;
  check("HP 0.5 Hz removes a 0.2 Hz sinusoid", r < 0.2, `residual ${(r * 100).toFixed(1)}%`);
}
{
  const y = applyFilters(sine(0.2), fs, { hp: 0.05, notch: 0, lp: 0 });
  const r = rms(y) / ref;
  check("HP 0.05 Hz keeps a 0.2 Hz sinusoid", r > 0.9, `gain ${(r * 100).toFixed(1)}%`);
}
{
  const y = applyFilters(sine(50), fs, { hp: 0, notch: 50, lp: 0 });
  const r = rms(y) / ref;
  check("Notch 50 Hz removes a 50 Hz sinusoid", r < 0.02, `residual ${(r * 100).toFixed(2)}%`);
}
{
  const y = applyFilters(sine(60), fs, { hp: 0, notch: 60, lp: 0 });
  const r = rms(y) / ref;
  check("Notch 60 Hz removes a 60 Hz sinusoid", r < 0.02, `residual ${(r * 100).toFixed(2)}%`);
}
{
  const y = applyFilters(sine(120), fs, { hp: 0, notch: 0, lp: 40 });
  const r = rms(y) / ref;
  check("LP 40 Hz removes a 120 Hz sinusoid", r < 0.05, `residual ${(r * 100).toFixed(2)}%`);
}
{
  const y = applyFilters(sine(10), fs, { hp: 0.5, notch: 50, lp: 40 });
  const r = rms(y) / ref;
  check("Full chain passes a 10 Hz sinusoid", Math.abs(r - 1) < 0.05, `gain ${(r * 100).toFixed(1)}%`);
}
{
  // Zero phase: the filtered 10 Hz sine stays aligned (peak lag < 1 sample).
  const x = sine(10);
  const y = applyFilters(x, fs, { hp: 0.5, notch: 50, lp: 40 });
  let best = 0, lag = 0;
  for (let k = -10; k <= 10; k++) {
    let s = 0;
    for (let i = 2 * fs; i < N - 2 * fs; i++) s += x[i] * y[i + k];
    if (s > best) { best = s; lag = k; }
  }
  check("Filters are zero-phase", lag === 0, `lag ${lag} samples`);
}

// ---------------- Pan–Tompkins on the 10 PTB-XL records ----------------
/** Independent HR estimate: autocorrelation of the QRS energy envelope (band-passed, squared derivative). */
function autocorrHr(x, fs) {
  const y = applyFilters(x, fs, { hp: 5, notch: 0, lp: 15 });
  const e = new Float64Array(y.length);
  for (let i = 1; i < y.length; i++) e[i] = (y[i] - y[i - 1]) ** 2;
  let m = 0;
  for (const v of e) m += v;
  m /= e.length;
  for (let i = 0; i < e.length; i++) e[i] -= m;
  let best = -Infinity, lag = 0;
  for (let k = Math.round(0.3 * fs); k <= Math.round(2 * fs); k++) {
    let s = 0;
    for (let i = 0; i + k < e.length; i++) s += e[i] * e[i + k];
    s /= e.length - k;
    if (s > best) { best = s; lag = k; }
  }
  return 60 / (lag / fs);
}

const files = readdirSync(seed).filter((f) => /^HR\d+\.json$/.test(f)).sort();
console.log("\nrecord   beats  HR(det)  HR(acorr)  RR sd ms  searchBack  Twave  dx");
for (const f of files) {
  const rec = JSON.parse(readFileSync(join(seed, f), "utf8"));
  const lead = rec.leads.II;
  const { peaks, stats } = panTompkins(lead, rec.fs);
  const rr = peaks.slice(1).map((p, i) => (p - peaks[i]) / rec.fs);
  const mean = rr.reduce((a, b) => a + b, 0) / Math.max(1, rr.length);
  const sd = Math.sqrt(rr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rr.length));
  const hr = 60 / mean;
  const ac = autocorrHr(lead, rec.fs);
  // Expect beats ≈ duration × HR/60, and agreement with the autocorrelation HR (or a harmonic of it).
  const ratio = hr / ac;
  const agree = [0.5, 1, 2].some((h) => Math.abs(ratio - h) / h < 0.12);
  const expected = (rec.samples / rec.fs) * (hr / 60);
  const countOk = Math.abs(peaks.length - expected) <= 2;
  check(
    `${rec.record}`,
    agree && countOk && hr > 30 && hr < 200,
    `${String(peaks.length).padStart(3)} beats, HR ${hr.toFixed(0)} bpm, acorr ${ac.toFixed(0)} bpm, RR sd ${(sd * 1000).toFixed(0)} ms, searchBack ${stats.searchBack}, T-rejected ${stats.tWaveRejected}, dx ${rec.dx}`,
  );
}

// ---------------- WFDB .atr round trip + ustar ----------------
{
  const anns = [
    { sample: 10, code: 28, aux: "(N" },
    { sample: 250, code: 1, chan: 0 },
    { sample: 700, code: 5, chan: 1 },
    { sample: 700 + 5000, code: 1, chan: 1 }, // > 1023 → SKIP
    { sample: 9000, code: 28, aux: "(AFIB" },
    { sample: 9100, code: 14, sub: -1 },
  ];
  const bytes = encodeAtr(anns);
  const back = decodeAtr(bytes);
  const same = back.length === anns.length && anns.every((a, i) => back[i].sample === a.sample && back[i].code === a.code && (back[i].aux ?? "") === (a.aux ?? "") && back[i].chan === (a.chan ?? (i ? back[i - 1].chan : 0)) && (back[i].sub ?? 0) === (a.sub ?? 0));
  check(".atr encode/decode round trip (SKIP, AUX, CHN, SUB)", same, `${bytes.length} bytes`);
  const tar = ustar([{ name: "HR00001.atr", data: bytes }, { name: "RECORDS", data: new TextEncoder().encode("HR00001\n") }]);
  check("ustar size is a multiple of 512", tar.length % 512 === 0, `${tar.length} bytes`);
  if (process.env.SELFTEST_OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(process.env.SELFTEST_OUT, "selftest.tar"), tar);
    writeFileSync(join(process.env.SELFTEST_OUT, "selftest.atr"), bytes);
    console.log(`wrote ${process.env.SELFTEST_OUT}/selftest.tar and selftest.atr`);
  }
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
