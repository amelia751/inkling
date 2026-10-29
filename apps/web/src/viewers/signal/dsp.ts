/**
 * ECG signal processing for the waveform viewer: display filters and Pan–Tompkins QRS
 * detection. Pure functions only — they run in the DSP worker, on the main thread as a
 * fallback, and in node for the self-test (so the only import is a bare package name).
 *
 * All filters are zero-phase (forward–backward), so filtered samples stay aligned with
 * the raw time axis that annotations are stored on.
 */
import { biquad, butterworth, filtfilt } from "digital-filter";

/** Display filter settings. 0 disables a stage. */
export interface FilterConfig {
  /** High-pass (baseline wander) cutoff, Hz: 0.05 (diagnostic) or 0.5 (monitoring). */
  hp: number;
  /** Mains notch, Hz: 50 or 60. */
  notch: number;
  /** Low-pass (muscle/EMG noise) cutoff, Hz: 40, 100 or 150. */
  lp: number;
}

export const NO_FILTER: FilterConfig = { hp: 0, notch: 0, lp: 0 };

export function filterKey(c: FilterConfig): string {
  return `hp${c.hp}|n${c.notch}|lp${c.lp}`;
}

export function isPassthrough(c: FilterConfig): boolean {
  return !c.hp && !c.notch && !c.lp;
}

/** Edge padding for filtfilt: long enough that the very low baseline cutoffs settle. */
function padFor(n: number, fs: number) {
  return Math.max(0, Math.min(n - 1, Math.round(2 * fs)));
}

/** Notch quality factor: ~1.7 Hz wide at 50 Hz, doubled in depth by the forward–backward pass. */
const NOTCH_Q = 30;

/** Apply the display filter chain (HP → notch → LP), zero-phase. Returns a new array. */
export function applyFilters(x: ArrayLike<number>, fs: number, c: FilterConfig): Float32Array {
  const y = Float64Array.from(x as ArrayLike<number>);
  const nyq = fs / 2;
  const padlen = padFor(y.length, fs);
  if (y.length > 8) {
    if (c.hp > 0 && c.hp < nyq) filtfilt(y, { coefs: butterworth(2, c.hp, fs, "highpass"), padlen });
    if (c.notch > 0 && c.notch < nyq) filtfilt(y, { coefs: biquad.notch(c.notch, NOTCH_Q, fs), padlen });
    if (c.lp > 0 && c.lp < nyq) filtfilt(y, { coefs: butterworth(2, c.lp, fs, "lowpass"), padlen });
  }
  return Float32Array.from(y);
}

export interface PanTompkinsResult {
  /** R-peak sample indices, ascending. */
  peaks: number[];
  /** Detector internals, for the self-test and debugging. */
  stats: { candidates: number; searchBack: number; tWaveRejected: number };
}

/**
 * Pan & Tompkins (1985) QRS detector.
 *
 * 1. Band-pass 5–15 Hz (Butterworth, zero-phase).
 * 2. Five-point derivative, 3. squaring, 4. 150 ms moving-window integration (trailing).
 * 5. Candidate peaks of the integrated signal at least 200 ms apart (refractory period),
 *    classified with adaptive thresholds SPKI/NPKI: THR1 = NPKI + 0.25(SPKI − NPKI), THR2 = 0.5·THR1.
 *    Search-back at 1.66 × mean RR for missed beats (with THR2); a candidate 200–360 ms after
 *    the previous QRS whose maximal slope is under half of that QRS's slope is taken as a T wave.
 * 6. Each detection is located on the band-passed signal inside its integration window and then
 *    refined to the max |x| within ±50 ms of the (baseline-corrected) `refine` signal.
 */
export function panTompkins(x: ArrayLike<number>, fs: number, refine?: ArrayLike<number>): PanTompkinsResult {
  const n = x.length;
  const stats = { candidates: 0, searchBack: 0, tWaveRejected: 0 };
  if (n < fs) return { peaks: [], stats };

  const bp = Float64Array.from(x as ArrayLike<number>);
  filtfilt(bp, { coefs: butterworth(2, [5, 15], fs, "bandpass"), padlen: Math.min(n - 1, Math.round(fs)) });

  const d = new Float64Array(n);
  for (let i = 2; i < n - 2; i++) d[i] = ((2 * bp[i + 1] + bp[i + 2] - bp[i - 2] - 2 * bp[i - 1]) * fs) / 8;

  const W = Math.max(1, Math.round(0.15 * fs));
  const mwi = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += d[i] * d[i];
    if (i >= W) acc -= d[i - W] * d[i - W];
    mwi[i] = acc / W;
  }

  const refractory = Math.round(0.2 * fs);
  const tWaveLimit = Math.round(0.36 * fs);

  // Candidate peaks: local maxima, greedily kept by height with a 200 ms minimum spacing.
  const maxima: number[] = [];
  for (let i = 1; i < n - 1; i++) if (mwi[i] > mwi[i - 1] && mwi[i] >= mwi[i + 1]) maxima.push(i);
  maxima.sort((a, b) => mwi[b] - mwi[a]);
  const taken = new Uint8Array(n);
  const cand: number[] = [];
  for (const i of maxima) {
    let ok = true;
    for (let j = Math.max(0, i - refractory + 1); j < Math.min(n, i + refractory); j++) {
      if (taken[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      taken[i] = 1;
      cand.push(i);
    }
  }
  cand.sort((a, b) => a - b);
  stats.candidates = cand.length;

  const slopeAt = (i: number) => {
    let m = 0;
    for (let j = Math.max(0, i - W); j <= i; j++) m = Math.max(m, Math.abs(d[j]));
    return m;
  };

  // Learning phase: first 2 s.
  const train = Math.min(n, 2 * fs);
  let mx = 0;
  let mean = 0;
  for (let i = 0; i < train; i++) {
    mx = Math.max(mx, mwi[i]);
    mean += mwi[i];
  }
  mean /= train;
  let SPKI = mx / 3;
  let NPKI = mean / 2;
  const thr1 = () => NPKI + 0.25 * (SPKI - NPKI);

  const qrs: number[] = [];
  const qrsSlope: number[] = [];
  const accepted = new Set<number>();
  const meanRR = () => {
    if (qrs.length < 2) return 0;
    const k = Math.min(8, qrs.length - 1);
    return (qrs[qrs.length - 1] - qrs[qrs.length - 1 - k]) / k;
  };
  const accept = (i: number) => {
    qrs.push(i);
    qrsSlope.push(slopeAt(i));
    accepted.add(i);
  };
  /** Look back over skipped candidates between the last QRS and `until` for one above THR2. */
  const searchBack = (until: number) => {
    const rr = meanRR();
    const last = qrs[qrs.length - 1];
    if (!rr || until - last <= 1.66 * rr) return;
    const thr2 = 0.5 * thr1();
    let best = -1;
    for (const c of cand) {
      if (c <= last + refractory || c >= until - refractory + 1 || accepted.has(c)) continue;
      if (mwi[c] > thr2 && (best < 0 || mwi[c] > mwi[best])) best = c;
    }
    if (best >= 0) {
      SPKI = 0.25 * mwi[best] + 0.75 * SPKI;
      accept(best);
      stats.searchBack++;
    }
  };

  for (const i of cand) {
    if (qrs.length) searchBack(i);
    const v = mwi[i];
    const last = qrs.length ? qrs[qrs.length - 1] : -Infinity;
    if (v >= thr1()) {
      if (i - last < refractory) {
        NPKI = 0.125 * v + 0.875 * NPKI;
        continue;
      }
      if (i - last < tWaveLimit && slopeAt(i) < 0.5 * qrsSlope[qrsSlope.length - 1]) {
        NPKI = 0.125 * v + 0.875 * NPKI;
        stats.tWaveRejected++;
        continue;
      }
      SPKI = 0.125 * v + 0.875 * SPKI;
      accept(i);
    } else {
      NPKI = 0.125 * v + 0.875 * NPKI;
    }
  }
  if (qrs.length) searchBack(n);
  qrs.sort((a, b) => a - b);

  // Locate each R peak: band-pass extremum in the integration window, then refine on the
  // baseline-corrected signal (max |x| within ±50 ms).
  const ref = refine ?? applyFilters(x, fs, { hp: 0.5, notch: 0, lp: 40 });
  const r50 = Math.round(0.05 * fs);
  const peaks: number[] = [];
  for (const i of qrs) {
    let k = i;
    let best = -1;
    for (let j = Math.max(0, i - W); j <= i; j++) {
      if (Math.abs(bp[j]) > best) {
        best = Math.abs(bp[j]);
        k = j;
      }
    }
    peaks.push(argMaxAbs(ref, k - r50, k + r50));
  }
  peaks.sort((a, b) => a - b);
  const out: number[] = [];
  for (const p of peaks) {
    const prev = out[out.length - 1];
    if (prev !== undefined && p - prev < refractory) {
      if (Math.abs(ref[p]) > Math.abs(ref[prev])) out[out.length - 1] = p;
    } else out.push(p);
  }
  return { peaks: out, stats };
}

/** Index of max |x[i] − baseline| in [i0, i1], baseline = mean of the window. */
export function argMaxAbs(x: ArrayLike<number>, i0: number, i1: number): number {
  const a = Math.max(0, Math.floor(i0));
  const b = Math.min(x.length - 1, Math.ceil(i1));
  let mean = 0;
  for (let j = a; j <= b; j++) mean += x[j];
  mean /= Math.max(1, b - a + 1);
  let k = a;
  let best = -1;
  for (let j = a; j <= b; j++) {
    const v = Math.abs(x[j] - mean);
    if (v > best) {
      best = v;
      k = j;
    }
  }
  return k;
}

/** Snap a time (s) to the local extremum of a signal within ±radius seconds. */
export function snapToExtremum(x: ArrayLike<number>, fs: number, t: number, radius = 0.05): number {
  const i = Math.round(t * fs);
  return argMaxAbs(x, i - radius * fs, i + radius * fs) / fs;
}

/** Peak of a wave between onset and offset (s): extremum relative to the line joining the ends. */
export function wavePeak(x: ArrayLike<number>, fs: number, onset: number, offset: number): number {
  const a = Math.max(0, Math.round(onset * fs));
  const b = Math.min(x.length - 1, Math.round(offset * fs));
  if (b <= a) return onset;
  const ya = x[a];
  const yb = x[b];
  let k = a;
  let best = -1;
  for (let j = a; j <= b; j++) {
    const base = ya + ((yb - ya) * (j - a)) / (b - a);
    const v = Math.abs(x[j] - base);
    if (v > best) {
      best = v;
      k = j;
    }
  }
  return k / fs;
}
