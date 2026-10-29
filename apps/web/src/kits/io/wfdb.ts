/**
 * Binary writers for WFDB export: MIT-format annotation files (.atr) and a minimal POSIX
 * ustar archive to bundle one annotation file per record into a single download.
 *
 * MIT annotation format (WFDB Programmer's Guide, annot(5)):
 *   Each annotation is a 16-bit little-endian word: bits 15–10 = code (A), bits 9–0 = time
 *   since the previous annotation in samples (I). Pseudo-annotations use A ≥ 59:
 *     SKIP (59): I = 0, followed by a 32-bit interval stored as two little-endian 16-bit words,
 *                high word first (PDP-11 order); the next annotation word then carries I = 0.
 *     NUM  (60): I = annotation `num` (persistent until changed).
 *     SUB  (61): I = subtype (written only when non-zero; signed byte, so −1 → 0xFF).
 *     CHN  (62): I = signal number (persistent until changed; initial value 0).
 *     AUX  (63): I = byte count, followed by the bytes, padded to an even length.
 *   SKIP precedes the annotation it applies to; SUB/CHN/NUM/AUX follow it. A zero word ends the file.
 *
 * Self-contained (no imports) so the node self-test can load it.
 */

export interface AtrAnnotation {
  /** Sample index from the start of the record. */
  sample: number;
  /** WFDB annotation code (1–49, ecgcodes.h). */
  code: number;
  chan?: number;
  sub?: number;
  num?: number;
  aux?: string;
}

const SKIP = 59, NUM = 60, SUB = 61, CHN = 62, AUX = 63;

export function encodeAtr(input: AtrAnnotation[]): Uint8Array {
  const anns = [...input].sort((a, b) => a.sample - b.sample);
  const out: number[] = [];
  const word = (w: number) => out.push(w & 0xff, (w >> 8) & 0xff);
  let prev = 0;
  let chan = 0;
  let num = 0;
  for (const a of anns) {
    let dt = Math.max(0, Math.round(a.sample) - prev);
    prev += dt;
    if (dt > 1023) {
      word(SKIP << 10);
      word((dt >>> 16) & 0xffff);
      word(dt & 0xffff);
      dt = 0;
    }
    word(((a.code & 0x3f) << 10) | dt);
    if (a.sub) word((SUB << 10) | (a.sub & 0xff));
    if ((a.chan ?? chan) !== chan) {
      chan = a.chan ?? chan;
      word((CHN << 10) | (chan & 0x3ff));
    }
    if ((a.num ?? num) !== num) {
      num = a.num ?? num;
      word((NUM << 10) | (num & 0x3ff));
    }
    if (a.aux) {
      const bytes = new TextEncoder().encode(a.aux).slice(0, 255);
      word((AUX << 10) | bytes.length);
      out.push(...bytes);
      if (bytes.length % 2) out.push(0);
    }
  }
  word(0);
  return Uint8Array.from(out);
}

/** Decoder for the same subset; used by the self-test to verify round trips. */
export function decodeAtr(bytes: Uint8Array): (AtrAnnotation & { chan: number; num: number })[] {
  const out: (AtrAnnotation & { chan: number; num: number })[] = [];
  let p = 0;
  let t = 0;
  let chan = 0;
  let num = 0;
  const rd = () => {
    const w = bytes[p] | (bytes[p + 1] << 8);
    p += 2;
    return w;
  };
  while (p + 1 < bytes.length) {
    const w = rd();
    const a = w >> 10;
    const i = w & 0x3ff;
    if (a === 0 && i === 0) break;
    if (a === SKIP) {
      const hi = rd();
      const lo = rd();
      t += hi * 65536 + lo;
    } else if (a === NUM) {
      num = i;
      out[out.length - 1].num = i;
    } else if (a === SUB) {
      out[out.length - 1].sub = (i & 0xff) > 127 ? (i & 0xff) - 256 : i & 0xff;
    } else if (a === CHN) {
      chan = i;
      out[out.length - 1].chan = i;
    } else if (a === AUX) {
      out[out.length - 1].aux = new TextDecoder().decode(bytes.slice(p, p + i));
      p += i + (i % 2);
    } else {
      t += i;
      out.push({ sample: t, code: a, chan, num });
    }
  }
  return out;
}

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

/** Minimal POSIX ustar writer: regular files only, names ≤ 100 bytes. */
export function ustar(entries: TarEntry[], mtime = Math.floor(Date.now() / 1000)): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const e of entries) {
    const h = new Uint8Array(512);
    const put = (s: string, off: number, len: number) => h.set(enc.encode(s).slice(0, len), off);
    const oct = (v: number, len: number) => v.toString(8).padStart(len - 1, "0") + "\0";
    put(e.name, 0, 100);
    put(oct(0o644, 8), 100, 8);
    put(oct(0, 8), 108, 8);
    put(oct(0, 8), 116, 8);
    put(oct(e.data.length, 12), 124, 12);
    put(oct(mtime, 12), 136, 12);
    put("        ", 148, 8);
    put("0", 156, 1);
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    put("inkling", 265, 32);
    put("inkling", 297, 32);
    let sum = 0;
    for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(h);
    const body = new Uint8Array(Math.ceil(e.data.length / 512) * 512);
    body.set(e.data);
    blocks.push(body);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

export interface WfdbHeader {
  record: string;
  /** Number of signals. */
  nsig: number;
  /** Sampling frequency (Hz); `undefined` when the header leaves it out. */
  fs?: number;
  samples: number;
  /** Signal descriptions (the free-text last field of each signal line), e.g. lead names. */
  signals: string[];
}

/** Parse the record and signal lines of a WFDB header (.hea, header(5)); comment lines are skipped. */
export function parseHeader(text: string): WfdbHeader {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  const [name, nsig, fsField, samples] = (lines[0] ?? "").split(/\s+/);
  const n = +nsig || 0;
  return {
    record: name,
    nsig: n,
    fs: parseFloat(fsField) || undefined,
    samples: +samples || 0,
    signals: lines.slice(1, 1 + n).map((l) => l.split(/\s+/).slice(8).join(" ")),
  };
}
