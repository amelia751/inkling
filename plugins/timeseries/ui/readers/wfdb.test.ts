import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeWfdb, parseRecordHeader } from "./wfdb";

// The PhysioNet/CinC 2020 sample the seeds ship (gitignored; `pnpm seeds`). Main checkout's
// seed-data when run from a worktree.
const SEED = [resolve(__dirname, "../../../../seed-data/ecg-waveform/raw"), resolve(__dirname, "../../../../../../seed-data/ecg-waveform/raw")].find((d) => existsSync(`${d}/HR00001.hea`));

/** A MATLAB v4 int16 matrix as PhysioNet writes it: mrows = signals, ncols = samples, column-major. */
function mat(frames: number[][]): Uint8Array {
  const nsig = frames[0].length;
  const buf = new ArrayBuffer(24 + frames.length * nsig * 2);
  const v = new DataView(buf);
  [30, nsig, frames.length, 0, 4].forEach((x, i) => v.setInt32(i * 4, x, true));
  new Uint8Array(buf).set([0x76, 0x61, 0x6c, 0], 20);
  frames.flat().forEach((x, i) => v.setInt16(24 + i * 2, x, true));
  return new Uint8Array(buf);
}

describe("WFDB binary reader", () => {
  it("parses gain(baseline)/units and the byte offset", () => {
    const h = parseRecordHeader("r 2 360 3\nr.dat 16+24 200(10)/mV 16 0 0 0 0 MLII\nr.dat 16 100/uV 12 5 0 0 0 V5\n#Dx: 1,2");
    expect(h.signals[0]).toMatchObject({ format: 16, offset: 24, gain: 200, baseline: 10, units: "mV", description: "MLII" });
    expect(h.signals[1]).toMatchObject({ gain: 100, baseline: 5, units: "uV" });
    expect(h.dx).toBe("1,2");
  });

  it("decodes a MATLAB v4 .mat into physical units", () => {
    const hea = "rec 2 500 3\nrec.mat 16+24 200/mV 16 0 0 0 0 I\nrec.mat 16+24 100(10)/mV 16 0 0 0 0 II";
    const r = decodeWfdb(hea, { "rec.mat": mat([[200, 110], [-100, 10], [0, -90]]) });
    expect(r.channels).toEqual(["I", "II"]);
    expect(r.samples).toBe(3);
    expect(Array.from(r.data.I)).toEqual([1, -0.5, 0]);
    expect(Array.from(r.data.II)).toEqual([1, 0, -1]);
  });

  it("decodes format 16 and 212 .dat", () => {
    const d16 = new Uint8Array(new Int16Array([200, -200, 400, 0]).buffer);
    const r = decodeWfdb("x 2 250 2\nx.dat 16 200/mV 16 0 0 0 0 A\nx.dat 16 200/mV 16 0 0 0 0 B", { "x.dat": d16 });
    expect(Array.from(r.data.A)).toEqual([1, 2]);
    expect(Array.from(r.data.B)).toEqual([-1, 0]);
    // 212: samples 100 and -2 (0xffe) in three bytes.
    const r212 = decodeWfdb("y 2 250 1\ny.dat 212 1 12 0 0 0 0 A\ny.dat 212 1 12 0 0 0 0 B", { "y.dat": new Uint8Array([100, 0xf0, 0xfe]) });
    expect([r212.data.A[0], r212.data.B[0]]).toEqual([100, -2]);
  });

  it.skipIf(!SEED)("decodes the CinC 2020 seed HR00001 (.hea + .mat)", () => {
    const hea = readFileSync(`${SEED}/HR00001.hea`, "utf8");
    const r = decodeWfdb(hea, { "HR00001.mat": new Uint8Array(readFileSync(`${SEED}/HR00001.mat`)) });
    expect(r).toMatchObject({ record: "HR00001", fs: 500, samples: 5000, dx: "251146004,426783006" });
    expect(r.channels).toEqual(["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]);
    // First sample equals the header's initial value / gain; amplitudes stay within a few mV.
    expect(r.data.I[0]).toBeCloseTo(-115 / 200);
    expect(r.data.V6[0]).toBeCloseTo(-75 / 200);
    expect(Math.max(...r.data.II.map(Math.abs))).toBeLessThan(10);
    // Matches the seeds' JSON rendering of the same record, when it is there.
    const json = `${SEED}/../ecg-waveform/HR00001.json`;
    if (existsSync(json)) {
      const leads = JSON.parse(readFileSync(json, "utf8")).leads as Record<string, number[]>;
      expect(r.data.II[1000]).toBeCloseTo(leads.II[1000], 3);
    }
  });
});
