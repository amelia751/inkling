import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Just enough tar for plugin source (todo10 Phase 7): read what a build sandbox packed (to digest
 * it, for comparison with our own build), and write a tarball host-side (fake sandboxes, tests).
 * Regular files only; links, devices and unsafe paths are refused.
 */

const EXCLUDE = new Set(["node_modules", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".data"]);

const str = (b: Buffer, off: number, len: number) => b.subarray(off, off + len).toString("utf8").replace(/\0.*$/s, "");
const oct = (b: Buffer, off: number, len: number) => Number.parseInt(str(b, off, len).trim() || "0", 8);

function safe(name: string): string {
  const n = name.startsWith("./") ? name.slice(2) : name;
  const parts = n.split("/");
  if (!n || n.startsWith("/") || parts.includes("..") || parts.some((p) => p === "")) throw new Error(`unsafe archive member ${JSON.stringify(name).slice(0, 80)}`);
  return n;
}

export function readTarGz(data: Uint8Array, limits = { maxFiles: 2000, maxBytes: 64 * 1024 * 1024 }): Map<string, Buffer> {
  const buf = gunzipSync(data, { maxOutputLength: limits.maxBytes });
  const out = new Map<string, Buffer>();
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = oct(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h, 345, 155);
    let name = longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    longName = undefined;
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x") {
      const m = body.toString("utf8").match(/\d+ path=([^\n]*)\n/);
      if (m) longName = m[1];
      continue;
    }
    if (type === "g") continue;
    if (type === "5") continue; // directory
    if (type !== "0" && type !== "\0") throw new Error("only regular files are allowed (no links or devices)");
    name = safe(name);
    if (name === ".") continue;
    out.set(name, Buffer.from(body));
    if (out.size > limits.maxFiles) throw new Error("too many files");
  }
  return out;
}

function header(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  const n = Buffer.from(name);
  if (n.length > 100) {
    if (n.length > 255) throw new Error(`path too long: ${name.slice(0, 80)}`);
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long: ${name.slice(0, 80)}`);
    h.write(name.slice(cut + 1), 0);
    h.write(name.slice(0, cut), 345);
  } else h.write(name, 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

/** Sorted entries, zero mtimes and owners: the same files always give the same bytes. */
export function writeTarGz(files: Map<string, Uint8Array> | Record<string, Uint8Array | string>): Buffer {
  const entries = (files instanceof Map ? [...files.entries()] : Object.entries(files)).map(([k, v]) => [safe(k), typeof v === "string" ? Buffer.from(v) : Buffer.from(v)] as const);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: Buffer[] = [];
  for (const [name, data] of entries) {
    parts.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

/** The registry's file-tree digest (apps/api plugins/digest.py, tools/build-registry.mjs). */
export function filesDigest(files: Map<string, Uint8Array>): string {
  const h = createHash("sha256");
  for (const rel of [...files.keys()].sort()) {
    if (rel.split("/").some((p) => EXCLUDE.has(p))) continue;
    h.update(`${rel}\0${createHash("sha256").update(files.get(rel)!).digest("hex")}\n`);
  }
  return `sha256:${h.digest("hex")}`;
}
