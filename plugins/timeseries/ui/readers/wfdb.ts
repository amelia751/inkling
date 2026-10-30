import { parseHeader } from "@studio/renderers/io/wfdb";
import type { StudioItem } from "@studio/contracts/types";
import type { RecordInfo, Recording, SignalReader } from "./types";
import { assetUrl } from "@studio/plugin-ui-sdk";

/**
 * WFDB records as the seeds ship them: a JSON rendering of the samples (`{ record, fs,
 * samples, dx, leads: { I: [...], … } }`, amplitudes in physical units) plus, in
 * `asset.raw`, the original `.hea` header (and signal file), which `info` parses without
 * downloading the samples.
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

export const wfdbReader: SignalReader = {
  id: "wfdb",
  accepts: (path) => /\.(json|hea|dat)$/i.test(path),
  async read(item, { signal }) {
    const res = await fetch(assetUrl(item.assets[0].path), { signal });
    if (!res.ok) throw new Error(`${res.status}`);
    return fromJson((await res.json()) as RecordingJson);
  },
  async info(item): Promise<RecordInfo | undefined> {
    const asset = item.assets[0] as Asset;
    const hea = asset.raw?.find((p) => p.endsWith(".hea"));
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
