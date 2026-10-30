import * as nifti from "nifti-reader-js";
import { assetUrl } from "@studio/plugin-ui-sdk";

export interface Volume {
  dims: [number, number, number];
  /** Number of time points; 1 for a static 3D volume. Voxel (i,j,k) at time t is data[i + j·nx + k·nx·ny + t·nx·ny·nz]. */
  frames: number;
  /** Voxel spacing in mm (i, j, k). */
  spacing: [number, number, number];
  data: Float32Array;
  /** Display window [low, high] from robust percentiles. */
  window: [number, number];
}

const cache = new Map<string, Promise<Volume>>();

export function loadVolume(path: string): Promise<Volume> {
  let p = cache.get(path);
  if (!p) {
    p = fetchVolume(path);
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p;
}

async function fetchVolume(path: string): Promise<Volume> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`Could not fetch ${path} (${res.status})`);
  let buf = await res.arrayBuffer();
  if (nifti.isCompressed(buf)) buf = nifti.decompress(buf) as ArrayBuffer;
  if (!nifti.isNIFTI(buf)) throw new Error(`${path} is not a NIfTI file`);
  const header = nifti.readHeader(buf);
  if (!header) throw new Error(`${path} has an unreadable NIfTI header`);
  const raw = nifti.readImage(header, buf);

  const typed = toTyped(header.datatypeCode, raw);
  const slope = header.scl_slope || 1;
  const inter = header.scl_inter || 0;
  const data = new Float32Array(typed.length);
  for (let i = 0; i < typed.length; i++) data[i] = typed[i] * slope + inter;

  return {
    dims: [header.dims[1], header.dims[2], Math.max(1, header.dims[3])],
    frames: header.dims[0] >= 4 ? Math.max(1, header.dims[4]) : 1,
    spacing: [header.pixDims[1] || 1, header.pixDims[2] || 1, header.pixDims[3] || 1],
    data,
    window: robustWindow(data),
  };
}

function toTyped(code: number, raw: ArrayBuffer): ArrayLike<number> {
  const T = nifti.NIFTI1;
  switch (code) {
    case T.TYPE_UINT8:
      return new Uint8Array(raw);
    case T.TYPE_INT8:
      return new Int8Array(raw);
    case T.TYPE_INT16:
      return new Int16Array(raw);
    case T.TYPE_UINT16:
      return new Uint16Array(raw);
    case T.TYPE_INT32:
      return new Int32Array(raw);
    case T.TYPE_UINT32:
      return new Uint32Array(raw);
    case T.TYPE_FLOAT32:
      return new Float32Array(raw);
    case T.TYPE_FLOAT64:
      return new Float64Array(raw);
    default:
      throw new Error(`Unsupported NIfTI datatype ${code}`);
  }
}

/** 0.5–99.5 percentile of non-zero voxels, sampled; background-heavy MRI otherwise looks washed out. */
function robustWindow(data: Float32Array): [number, number] {
  const step = Math.max(1, Math.floor(data.length / 200_000));
  const sample: number[] = [];
  for (let i = 0; i < data.length; i += step) if (data[i] !== 0) sample.push(data[i]);
  if (!sample.length) return [0, 1];
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor(sample.length * 0.005)];
  const hi = sample[Math.floor(sample.length * 0.995)];
  return [lo, hi > lo ? hi : lo + 1];
}
