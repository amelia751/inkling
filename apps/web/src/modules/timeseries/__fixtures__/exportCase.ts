import type { Annotation, Project, StudioItem } from "@/types";

/**
 * A v1 annotation set covering every strip-chart export path (beats on a lead and on all
 * leads, AI beats with attributes, waves with and without a peak, rhythms, noise and plain
 * intervals, record statements), two records (one with a WFDB header, one without) and a
 * fetch stub serving them. exporters.test.ts runs the v2 exporters on the migrated set and
 * compares with the bytes the v1 exporters wrote (export-golden.json).
 */
const HEA = "REC1 3 500 5000\nREC1.mat 16+24 1000/mV 16 0 0 0 0 I\nREC1.mat 16+24 1000/mV 16 0 0 0 0 II\nREC1.mat 16+24 1000/mV 16 0 0 0 0 V1\n# Age: 60\n";
const REC2 = { record: "REC2", fs: 250, samples: 2500, dx: "", leads: { I: [0, 0.1, 0.2], II: [0, 0.2, 0.1], III: [0, 0, 0] } };

export const project = {
  id: "golden",
  title: "Golden",
  environment: { extends: "preset:ecg" },
  assets: [],
} as unknown as Project;

export const items: StudioItem[] = [
  { id: "ecg/REC1.json", name: "REC1", group: "Recordings", dataKind: "inkling.timeseries.dataKinds.multichannel-timeseries", assets: [{ path: "ecg/REC1.json", record: "REC1", raw: ["ecg/raw/REC1.hea"] } as never] },
  { id: "ecg/REC2.json", name: "REC2", group: "Recordings", dataKind: "inkling.timeseries.dataKinds.multichannel-timeseries", assets: [{ path: "ecg/REC2.json", record: "REC2" } as never] },
];

const base = (id: string, itemId: string, label: string, geometry: unknown, extra: Partial<Annotation> = {}): Annotation =>
  ({ id, itemId, label, geometry, provenance: "human-created", author: "local-expert", createdAt: "2026-10-29T18:12:04.044Z", ...extra }) as Annotation;

const R1 = items[0].id;
const R2 = items[1].id;
export const v1Annotations: Annotation[] = [
  base("b1", R1, "QRS complex", { type: "beat", lead: "II", t: 0.512, code: "N" }),
  base("b2", R1, "QRS complex", { type: "beat", lead: "all", t: 1.3, code: "V" }),
  base("b3", R1, "QRS complex", { type: "beat", lead: "all", t: 2.104, code: "N" }, { provenance: "ai-suggested", attributes: { source: "pan-tompkins", lead: "II" } }),
  base("b4", R1, "QRS complex", { type: "beat", lead: "aVF", t: 3.0, code: "x?" }),
  base("b5", R1, "QRS complex", { type: "beat", lead: "V1", t: 9.5, code: "/" }, { provenance: "human-corrected", attributes: { source: "pan-tompkins", lead: "II" } }),
  base("w1", R1, "QRS complex", { type: "wave", lead: "II", wave: "QRS", onset: 0.46, peak: 0.512, offset: 0.56 }),
  base("w2", R1, "P wave", { type: "wave", lead: "all", wave: "P", onset: 0.3, offset: 0.4 }),
  base("w3", R1, "T wave", { type: "wave", lead: "V1", wave: "T", onset: 0.7, peak: 0.85, offset: 1.0 }, { attributes: { note: "flat" } }),
  base("r1", R1, "(AFIB", { type: "rhythm", start: 0.2, end: 4.0, rhythm: "(AFIB" }),
  base("r2", R1, "(N", { type: "rhythm", start: 4.0, end: 9.9, rhythm: "(N" }),
  base("i1", R1, "artifact", { type: "interval", lead: "all", start: 5.1, end: 5.8 }),
  base("i2", R1, "artifact", { type: "interval", lead: "V1", start: 6.0, end: 6.25 }),
  base("i3", R1, "P wave", { type: "interval", lead: "II", start: 7.0, end: 7.5 }, { locked: true }),
  base("c1", R1, "Atrial fibrillation", { type: "class" }, { attributes: { snomed: "164889003", source: "expert" } }),
  base("c2", R1, "P wave", { type: "class" }),
  base("b6", R2, "QRS complex", { type: "beat", lead: "II", t: 1.0, code: "A" }),
  base("w4", R2, "QRS complex", { type: "wave", lead: "III", wave: "QRS", onset: 0.9, peak: 1.0, offset: 1.1 }),
  base("i4", R2, "noise burst", { type: "interval", lead: "I", start: 2.0, end: 3.0 }),
];

/** Serves the two records (REC1 header only, REC2 samples) under /seed/. */
export function stubFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/seed/ecg/raw/REC1.hea") return new Response(HEA);
    if (url === "/seed/ecg/REC2.json") return new Response(JSON.stringify(REC2));
    if (url === "/seed/ecg/REC1.json") return new Response(JSON.stringify({ record: "REC1", fs: 500, samples: 5000, dx: "", leads: { I: [0], II: [0], V1: [0] } }));
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

/** Tar entries by name, as hex (ustar: 512-byte headers, size in octal at 124; mtime ignored). */
export function untar(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  for (let off = 0; off + 512 <= bytes.length; ) {
    const h = bytes.subarray(off, off + 512);
    const name = dec.decode(h.subarray(0, 100)).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(dec.decode(h.subarray(124, 136)).replace(/\0.*$/s, "").trim(), 8);
    out[name] = [...bytes.subarray(off + 512, off + 512 + size)].map((b) => b.toString(16).padStart(2, "0")).join("");
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

export const normaliseJson = (text: string) => text.replace(/"exportedAt": "[^"]+"/, '"exportedAt": "T"');
