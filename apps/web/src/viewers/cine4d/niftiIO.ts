import { seedUrl } from "@/lib/api";

/**
 * Minimal NIfTI-1 I/O for exports: read the source header's 348 bytes (only as much of
 * the gzip stream as needed) and write a uint8 label volume that keeps the source
 * geometry (pixdim, qform/sform, xyzt units) byte for byte.
 */

export interface NiftiHeaderInfo {
  bytes: Uint8Array;
  littleEndian: boolean;
  dim: number[];
  pixdim: number[];
}

const headerCache = new Map<string, Promise<NiftiHeaderInfo>>();

export function fetchHeader(path: string): Promise<NiftiHeaderInfo> {
  let p = headerCache.get(path);
  if (!p) {
    p = readHeader(path);
    p.catch(() => headerCache.delete(path));
    headerCache.set(path, p);
  }
  return p;
}

async function readHeader(path: string): Promise<NiftiHeaderInfo> {
  const res = await fetch(seedUrl(path));
  if (!res.ok || !res.body) throw new Error(`Could not fetch ${path} (${res.status})`);
  const src = res.body.getReader();
  const first = await src.read();
  const gz = !!first.value && first.value[0] === 0x1f && first.value[1] === 0x8b;
  let pushedFirst = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (!pushedFirst) {
        pushedFirst = true;
        if (first.value) return ctrl.enqueue(first.value);
      }
      const { value, done } = await src.read();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
    cancel: () => src.cancel(),
  });
  const stream = gz ? body.pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) : body;
  const reader = stream.getReader();
  const bytes = new Uint8Array(348);
  let n = 0;
  while (n < 348) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    const take = Math.min(value.length, 348 - n);
    bytes.set(value.subarray(0, take), n);
    n += take;
  }
  reader.cancel().catch(() => {});
  if (n < 348) throw new Error(`${path}: truncated NIfTI header`);
  return parseHeader(bytes);
}

export function parseHeader(bytes: Uint8Array): NiftiHeaderInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 348);
  const littleEndian = dv.getInt32(0, true) === 348;
  if (!littleEndian && dv.getInt32(0, false) !== 348) throw new Error("Not a NIfTI-1 header");
  const dim = Array.from({ length: 8 }, (_, i) => dv.getInt16(40 + 2 * i, littleEndian));
  const pixdim = Array.from({ length: 8 }, (_, i) => dv.getFloat32(76 + 4 * i, littleEndian));
  return { bytes, littleEndian, dim, pixdim };
}

/** NIfTI-1 single file (.nii) with uint8 labels; `dims` = [nx, ny, nz, nt]. */
export function writeLabelNifti(src: NiftiHeaderInfo, dims: [number, number, number, number], data: Uint8Array, descrip: string): Uint8Array {
  const out = new Uint8Array(352 + data.length);
  out.set(src.bytes, 0);
  const dv = new DataView(out.buffer);
  const le = src.littleEndian;
  const nd = dims[3] > 1 ? 4 : 3;
  dv.setInt16(40, nd, le);
  for (let i = 0; i < 4; i++) dv.setInt16(42 + 2 * i, i < nd ? dims[i] : 1, le);
  for (let i = 5; i < 8; i++) dv.setInt16(40 + 2 * i, 1, le);
  dv.setInt16(68, 1002, le); // intent_code = NIFTI_INTENT_LABEL
  dv.setInt16(70, 2, le); // datatype = DT_UINT8
  dv.setInt16(72, 8, le); // bitpix
  dv.setFloat32(108, 352, le); // vox_offset
  dv.setFloat32(112, 1, le); // scl_slope
  dv.setFloat32(116, 0, le); // scl_inter
  dv.setFloat32(124, 3, le); // cal_max
  dv.setFloat32(128, 0, le); // cal_min
  let max = 0;
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
  dv.setInt32(140, max, le); // glmax
  dv.setInt32(144, 0, le); // glmin
  const text = new TextEncoder().encode(descrip.slice(0, 79));
  out.fill(0, 148, 228);
  out.set(text, 148);
  out.fill(0, 328, 344); // intent_name
  out.set(new TextEncoder().encode("labels"), 328);
  out.set([0x6e, 0x2b, 0x31, 0x00], 344); // "n+1\0"
  out.fill(0, 348, 352); // no extensions
  out.set(data, 352);
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Blob> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

/** Height (cm) / weight (kg) from project meta, else from the ACDC Info.cfg next to the cine file. */
export async function fetchBodySize(cinePath: string, meta?: Record<string, string | number | null>): Promise<{ height: number | null; weight: number | null }> {
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && !isNaN(+v) ? +v : null);
  const fromMeta = { height: num(meta?.height ?? meta?.Height), weight: num(meta?.weight ?? meta?.Weight) };
  if (fromMeta.height && fromMeta.weight) return fromMeta;
  try {
    const dir = cinePath.split("/").slice(0, -1).join("/");
    const res = await fetch(seedUrl(`${dir}/Info.cfg`));
    if (!res.ok) return fromMeta;
    const text = await res.text();
    const get = (k: string) => num(new RegExp(`^${k}:\\s*([\\d.]+)`, "mi").exec(text)?.[1]);
    return { height: fromMeta.height ?? get("Height"), weight: fromMeta.weight ?? get("Weight") };
  } catch {
    return fromMeta;
  }
}
