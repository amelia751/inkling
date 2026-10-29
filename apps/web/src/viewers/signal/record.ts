import { seedUrl } from "@/lib/api";
import type { StudioItem } from "@/types";

/** Seed JSON for one ECG: PTB-XL record resampled to `fs`, amplitudes in mV. */
export interface RecordingJson {
  record: string;
  fs: number;
  samples: number;
  dx: string;
  leads: Record<string, number[]>;
}

export interface Recording {
  record: string;
  fs: number;
  samples: number;
  dx: string;
  leadNames: string[];
  leads: Record<string, Float32Array>;
}

export interface RecordInfo {
  record: string;
  fs: number;
  samples: number;
  leadNames: string[];
  /** Raw WFDB header text, when the seed ships one. */
  header?: string;
}

/** Known record geometry by item id: filled when the viewer loads a record, used by inspect/exporters. */
const infoCache = new Map<string, RecordInfo>();

export function cachedInfo(itemId: string): RecordInfo | undefined {
  return infoCache.get(itemId);
}

export async function loadRecording(item: StudioItem, signal?: AbortSignal): Promise<Recording> {
  const res = await fetch(seedUrl(item.assets[0].path), { signal });
  if (!res.ok) throw new Error(`${res.status}`);
  const j = (await res.json()) as RecordingJson;
  const leadNames = Object.keys(j.leads);
  const leads: Record<string, Float32Array> = {};
  for (const l of leadNames) leads[l] = Float32Array.from(j.leads[l]);
  const rec: Recording = { record: j.record, fs: j.fs, samples: j.samples, dx: j.dx, leadNames, leads };
  infoCache.set(item.id, { ...infoCache.get(item.id), record: j.record, fs: j.fs, samples: j.samples, leadNames });
  return rec;
}

/**
 * Record geometry for export without downloading the samples: parse the raw WFDB header when the
 * asset lists one (`raw: [*.hea, *.mat]`), else fall back to the JSON.
 */
export async function loadInfo(item: StudioItem): Promise<RecordInfo> {
  const hit = infoCache.get(item.id);
  if (hit?.header !== undefined) return hit;
  const asset = item.assets[0] as StudioItem["assets"][number] & { raw?: string[] };
  const hea = asset.raw?.find((p) => p.endsWith(".hea"));
  if (hea) {
    try {
      const res = await fetch(seedUrl(hea));
      if (res.ok) {
        const header = await res.text();
        const lines = header.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
        const [name, nsig, fsField, samples] = lines[0].split(/\s+/);
        const info: RecordInfo = {
          record: asset.record ?? name,
          fs: parseFloat(fsField) || 500,
          samples: +samples || 0,
          leadNames: lines.slice(1, 1 + +nsig).map((l) => l.split(/\s+/).slice(8).join(" ")),
          header,
        };
        infoCache.set(item.id, info);
        return info;
      }
    } catch {
      // fall through to the JSON
    }
  }
  if (hit) return hit;
  const rec = await loadRecording(item);
  return infoCache.get(item.id) ?? { record: rec.record, fs: rec.fs, samples: rec.samples, leadNames: rec.leadNames };
}

/** Median of a signal (baseline offset used to centre raw traces in their rows). */
export function median(x: Float32Array): number {
  if (!x.length) return 0;
  const step = Math.max(1, Math.floor(x.length / 2000));
  const s: number[] = [];
  for (let i = 0; i < x.length; i += step) s.push(x[i]);
  s.sort((a, b) => a - b);
  return s[s.length >> 1];
}
