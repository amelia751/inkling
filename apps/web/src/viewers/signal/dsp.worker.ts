import { applyFilters, panTompkins, type FilterConfig } from "./dsp";

export type DspRequest =
  | { id: number; type: "filter"; fs: number; config: FilterConfig; leads: Record<string, Float32Array> }
  | { id: number; type: "detect"; fs: number; signal: Float32Array };

export type DspResponse =
  | { id: number; type: "filter"; leads: Record<string, Float32Array> }
  | { id: number; type: "detect"; peaks: number[] }
  | { id: number; type: "error"; message: string };

const scope = self as unknown as { onmessage: ((e: MessageEvent<DspRequest>) => void) | null; postMessage: (m: DspResponse, transfer?: Transferable[]) => void };

scope.onmessage = (e) => {
  const req = e.data;
  try {
    if (req.type === "filter") {
      const leads: Record<string, Float32Array> = {};
      for (const [name, x] of Object.entries(req.leads)) leads[name] = applyFilters(x, req.fs, req.config);
      scope.postMessage({ id: req.id, type: "filter", leads }, Object.values(leads).map((l) => l.buffer as ArrayBuffer));
    } else {
      scope.postMessage({ id: req.id, type: "detect", peaks: panTompkins(req.signal, req.fs).peaks });
    }
  } catch (err) {
    scope.postMessage({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
