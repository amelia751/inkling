import { applyFilters, filterKey, isPassthrough, panTompkins, type FilterConfig } from "./dsp";
import type { DspRequest, DspResponse } from "./dsp.worker";

/**
 * Main-thread side of the DSP worker. Filtered leads are cached per (record, filter config);
 * each entry holds all leads of the record. If workers are unavailable the same pure
 * functions run inline.
 */
let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, (r: DspResponse) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./dsp.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<DspResponse>) => {
      pending.get(e.data.id)?.(e.data);
      pending.delete(e.data.id);
    };
    worker.onerror = () => {
      // Fail every request in flight; later calls fall back to inline processing.
      for (const [id, done] of pending) done({ id, type: "error", message: "DSP worker crashed" });
      pending.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

type Req = DspRequest extends infer R ? (R extends DspRequest ? Omit<R, "id"> : never) : never;

function call(req: Req, transfer: Transferable[] = []): Promise<DspResponse> {
  const w = getWorker();
  if (!w) return Promise.resolve(inline({ ...req, id: 0 } as DspRequest));
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, (r) => resolve(r.type === "error" ? inline({ ...req, id } as DspRequest) : r));
    w.postMessage({ ...req, id }, transfer);
  });
}

function inline(req: DspRequest): DspResponse {
  if (req.type === "filter") {
    const leads: Record<string, Float32Array> = {};
    for (const [k, v] of Object.entries(req.leads)) leads[k] = applyFilters(v, req.fs, req.config);
    return { id: req.id, type: "filter", leads };
  }
  return { id: req.id, type: "detect", peaks: panTompkins(req.signal, req.fs).peaks };
}

const CACHE_LIMIT = 24;
const cache = new Map<string, Promise<Record<string, Float32Array>>>();

/** Filtered copies of every lead of a record. Pass-through configs return the raw arrays. */
export function filteredLeads(record: string, fs: number, raw: Record<string, Float32Array>, config: FilterConfig): Promise<Record<string, Float32Array>> {
  if (isPassthrough(config)) return Promise.resolve(raw);
  const key = `${record}|${fs}|${filterKey(config)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  // Copies go to the worker so the raw arrays stay usable here.
  const leads: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(raw)) leads[k] = v.slice();
  const p = call({ type: "filter", fs, config, leads }, Object.values(leads).map((l) => l.buffer as ArrayBuffer)).then((r) => (r.type === "filter" ? r.leads : raw));
  cache.set(key, p);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return p;
}

/** Pan–Tompkins R peaks (sample indices) of one lead. */
export async function detectBeats(signal: Float32Array, fs: number): Promise<number[]> {
  const r = await call({ type: "detect", fs, signal: signal.slice() });
  return r.type === "detect" ? r.peaks : [];
}
