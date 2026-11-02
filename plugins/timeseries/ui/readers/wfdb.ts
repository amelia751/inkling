import { parseHeader } from "@studio/renderers/io/wfdb";
import type { StudioItem } from "@studio/contracts/types";
import type { RecordInfo, Recording, SignalReader } from "./types";
import { assetUrl } from "@studio/plugin-ui-sdk";

/**
 * WFDB records, two ways:
 * - as the seeds ship them: a JSON rendering of the samples (`{ record, fs, samples, dx,
 *   leads: { I: [...], … } }`, amplitudes in physical units) plus, in `asset.raw`, the
 *   original `.hea` header (and signal file), which `info` parses without downloading samples;
 * - as uploaded: the item's asset is the `.hea` and `asset.raw` is `[hea, signal file…]`
 *   (paths are content-addressed, so the kernel pairs them). `read` decodes the binary signal
 *   file: MATLAB v4 `.mat` as PhysioNet writes it, or format 16 / 212 `.dat`.
 */
export interface RecordingJson {
  record: string;
  fs: number;
  samples: number;
  dx: string;
  leads: Record<string, number[]>;
}

type Asset = StudioItem["assets"][number] & { raw?: string[]; record?: string };

export function fromJson(j: RecordingJson): Recording {
  const channels = Object.keys(j.leads);
  const data: Record<string, Float32Array> = {};
  for (const l of channels) data[l] = Float32Array.from(j.leads[l]);
  return { record: j.record, fs: j.fs, samples: j.samples, dx: j.dx, channels, data };
}

/** One signal line of a header (header(5)): `file fmt[+offset] gain[(baseline)][/units] adcres adczero initval checksum blocksize desc`. */
export interface SignalSpec {
  file: string;
  format: number;
  /** Byte offset of the first sample in the file (`fmt+offset`). */
  offset: number;
  gain: number;
  baseline: number;
  units: string;
  adcZero: number;
  description: string;
}

export interface WfdbRecordHeader {
  record: string;
  fs: number;
  samples: number;
  signals: SignalSpec[];
  /** `#Dx:` comment (PhysioNet/CinC), when present. */
  dx?: string;
}

export function parseRecordHeader(text: string): WfdbRecordHeader {
  const all = text.split(/\r?\n/);
  const lines = all.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const [name, nsig, fsField, samples] = (lines[0] ?? "").split(/\s+/);
  const n = +nsig || 0;
  const signals = lines.slice(1, 1 + n).map((l): SignalSpec => {
    const f = l.split(/\s+/);
    const fm = /^(\d+)(?:x[\d.]+)?(?::\d+)?(?:\+(\d+))?$/.exec(f[1] ?? "");
    const gm = /^([-\d.eE+]+)?(?:\(([-\d]+)\))?(?:\/(\S+))?$/.exec(f[2] ?? "");
    const adcZero = f[4] !== undefined ? +f[4] || 0 : 0;
    const gain = gm?.[1] !== undefined ? +gm[1] || 200 : 200;
    return {
      file: f[0],
      format: fm ? +fm[1] : NaN,
      offset: fm?.[2] ? +fm[2] : 0,
      gain,
      baseline: gm?.[2] !== undefined ? +gm[2] : adcZero,
      units: gm?.[3] ?? "mV",
      adcZero,
      description: f.slice(8).join(" ") || `sig${f.length}`,
    };
  });
  const dx = all.find((l) => /^#\s*Dx:/i.test(l))?.replace(/^#\s*Dx:\s*/i, "").trim();
  return { record: name, fs: parseFloat(fsField) || 250, samples: +samples || 0, signals, dx };
}

/** Where a MATLAB v4 matrix's data starts (20-byte header + name), and its element type. */
function matLayout(bytes: Uint8Array): { offset: number; format: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = v.getInt32(0, true);
  const namelen = v.getInt32(16, true);
  if (type < 0 || type > 9999 || Math.floor(type / 1000) !== 0) throw new Error("WFDB .mat: only little-endian MATLAB v4 files are supported");
  const p = Math.floor(type / 10) % 10; // MOPT: P = 0 double, 1 single, 2 int32, 3 int16, 4 uint16, 5 uint8
  const format = { 0: -64, 1: -32, 2: 32, 3: 16, 4: -16, 5: -8 }[p];
  if (format === undefined) throw new Error(`WFDB .mat: element type ${p} not supported`);
  return { offset: 20 + namelen, format };
}

/** Raw (digital) samples of `nsig` interleaved signals, `samples` frames from `offset`. */
function decodeFrames(bytes: Uint8Array, format: number, offset: number, nsig: number, samples: number): Int32Array | Float64Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = nsig * samples;
  const width = { 16: 2, [-16]: 2, 32: 4, [-32]: 4, [-64]: 8, [-8]: 1, 80: 1 }[format];
  if (format === 212) {
    const out = new Int32Array(total);
    for (let i = 0, b = offset; i < total && b + 2 < bytes.length; i += 2, b += 3) {
      const s0 = bytes[b] | ((bytes[b + 1] & 0x0f) << 8);
      const s1 = bytes[b + 2] | ((bytes[b + 1] & 0xf0) << 4);
      out[i] = s0 > 2047 ? s0 - 4096 : s0;
      if (i + 1 < total) out[i + 1] = s1 > 2047 ? s1 - 4096 : s1;
    }
    return out;
  }
  if (width === undefined) throw new Error(`WFDB format ${format} is not supported (16, 212, 80 and MATLAB .mat are)`);
  const n = Math.min(total, Math.floor((bytes.length - offset) / width));
  const out = format < 0 && format !== -8 && format !== -16 ? new Float64Array(total) : new Int32Array(total);
  for (let i = 0; i < n; i++) {
    const at = offset + i * width;
    out[i] =
      format === 16 ? v.getInt16(at, true)
      : format === -16 ? v.getUint16(at, true)
      : format === 32 ? v.getInt32(at, true)
      : format === -32 ? v.getFloat32(at, true)
      : format === -64 ? v.getFloat64(at, true)
      : format === -8 ? v.getUint8(at)
      : v.getUint8(at) - 128; // 80
  }
  return out;
}

/**
 * Decode a WFDB record: its header text and the bytes of each signal file it names (keyed by
 * that file name). Amplitudes come out in physical units: (adc - baseline) / gain.
 */
export function decodeWfdb(headerText: string, files: Record<string, Uint8Array>): Recording {
  const h = parseRecordHeader(headerText);
  if (!h.signals.length) throw new Error("WFDB header has no signals");
  const data: Record<string, Float32Array> = {};
  const names: string[] = [];
  let samples = h.samples;
  const byFile = new Map<string, number[]>();
  h.signals.forEach((s, i) => byFile.set(s.file, [...(byFile.get(s.file) ?? []), i]));
  for (const [file, idx] of byFile) {
    const bytes = files[file];
    if (!bytes) throw new Error(`WFDB signal file ${file} is missing`);
    const first = h.signals[idx[0]];
    let { format, offset } = first;
    if (/\.mat$/i.test(file)) {
      const m = matLayout(bytes);
      format = m.format;
      offset = offset || m.offset;
    }
    if (!samples) {
      const width = format === 212 ? 1.5 : Math.abs(format) / 8 || 2;
      samples = Math.floor((bytes.length - offset) / width / idx.length);
    }
    const raw = decodeFrames(bytes, format, offset, idx.length, samples);
    idx.forEach((si, k) => {
      const s = h.signals[si];
      const out = new Float32Array(samples);
      for (let t = 0; t < samples; t++) out[t] = (raw[t * idx.length + k] - s.baseline) / s.gain;
      let name = s.description;
      while (data[name]) name += "'";
      data[name] = out;
      names[si] = name;
    });
  }
  const channels = names.filter(Boolean);
  return { record: h.record, fs: h.fs, samples, channels, data, dx: h.dx };
}

const base = (p: string) => p.split("/").pop() ?? p;

/** The header and signal-file paths of an item: `asset.raw`, else the `.hea` asset itself. */
function wfdbPaths(asset: Asset): { hea?: string; signals: string[] } {
  const raw = asset.raw?.length ? asset.raw : [asset.path];
  return { hea: raw.find((p) => /\.hea$/i.test(p)), signals: raw.filter((p) => !/\.(hea|json)$/i.test(p)) };
}

async function fetchOk(path: string, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(assetUrl(path), { signal });
  if (!res.ok) throw new Error(`${res.status}`);
  return res;
}

async function readBinary(asset: Asset, signal?: AbortSignal): Promise<Recording> {
  const { hea, signals } = wfdbPaths(asset);
  if (!hea) throw new Error("WFDB record without a header (.hea)");
  const text = await (await fetchOk(hea, signal)).text();
  const names = [...new Set(parseRecordHeader(text).signals.map((s) => s.file))];
  const dir = hea.slice(0, hea.lastIndexOf("/") + 1);
  // Match each named file to a raw path by base name, else by position (content-addressed
  // uploads), else beside the header.
  const files: Record<string, Uint8Array> = {};
  await Promise.all(
    names.map(async (name, i) => {
      const path = signals.find((p) => base(p) === name) ?? signals.filter((p) => !names.includes(base(p)))[i] ?? dir + name;
      files[name] = new Uint8Array(await (await fetchOk(path, signal)).arrayBuffer());
    }),
  );
  const rec = decodeWfdb(text, files);
  return asset.record ? { ...rec, record: asset.record } : rec;
}

export const wfdbReader: SignalReader = {
  id: "wfdb",
  accepts: (path) => /\.(json|hea|dat|mat)$/i.test(path),
  async read(item, { signal }) {
    const asset = item.assets[0] as Asset;
    if (!/\.json$/i.test(asset.path)) return readBinary(asset, signal);
    const res = await fetchOk(asset.path, signal);
    return fromJson((await res.json()) as RecordingJson);
  },
  async info(item): Promise<RecordInfo | undefined> {
    const asset = item.assets[0] as Asset;
    const hea = wfdbPaths(asset).hea;
    if (!hea) return undefined;
    try {
      const res = await fetch(assetUrl(hea));
      if (!res.ok) return undefined;
      const header = await res.text();
      const h = parseHeader(header);
      return { record: asset.record ?? h.record, fs: h.fs || 500, samples: h.samples, channels: h.signals, header };
    } catch {
      return undefined;
    }
  },
};
