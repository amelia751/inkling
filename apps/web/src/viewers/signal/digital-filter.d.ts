// Minimal typings for digital-filter@2.4.3 (the package ships plain JS). Only what the ECG viewer uses.
declare module "digital-filter" {
  export interface Biquad {
    b0: number;
    b1: number;
    b2: number;
    a1: number;
    a2: number;
  }
  type Samples = Float64Array | Float32Array | number[];
  /** Nth-order Butterworth → cascaded second-order sections. `fc` is [lo, hi] for band types. */
  export function butterworth(order: number, fc: number | [number, number], fs: number, type?: "lowpass" | "highpass" | "bandpass" | "bandstop"): Biquad[];
  /** Causal SOS filter (DF2T), in place. */
  export function filter<T extends Samples>(data: T, params: { coefs: Biquad | Biquad[]; state?: [number, number][] }): T;
  /** Zero-phase forward–backward SOS filter with odd-reflection padding, in place. */
  export function filtfilt<T extends Samples>(data: T, params: { coefs: Biquad | Biquad[]; padlen?: number }): T;
  export const biquad: {
    notch(fc: number, Q: number, fs: number): Biquad;
    lowpass(fc: number, Q: number, fs: number): Biquad;
    highpass(fc: number, Q: number, fs: number): Biquad;
    bandpass(fc: number, Q: number, fs: number): Biquad;
  };
}
