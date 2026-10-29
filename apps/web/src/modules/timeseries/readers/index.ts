import { getRuntime, publish } from "@/platform/runtime";
import type { StudioItem } from "@/types";
import { csvReader } from "./csv";
import { infoOf, type RecordInfo, type Recording, type SignalReader } from "./types";
import { wfdbReader } from "./wfdb";

export { infoOf, type RecordInfo, type Recording, type SignalReader } from "./types";

/** Known formats. EDF / EDF+ is the next extension point (a reader with `accepts: /\.edf$/`). */
export const READERS: SignalReader[] = [wfdbReader, csvReader];

/** The reader for an item: by config (`reader`), else the first that accepts its file. */
export function readerFor(item: StudioItem, id: string = "auto"): SignalReader {
  if (id !== "auto") {
    const r = READERS.find((x) => x.id === id);
    if (r) return r;
  }
  return READERS.find((r) => r.accepts(item.assets[0]?.path ?? "")) ?? wfdbReader;
}

export async function loadRecording(item: StudioItem, opts: { reader?: string; signal?: AbortSignal; sampleRate?: number } = {}): Promise<Recording> {
  return readerFor(item, opts.reader).read(item, opts);
}

/**
 * Record geometry for exports and inspectors. Uses `runtime.signalInfo` (published by the
 * strip chart when it loads a record, or by an earlier call), then the reader's header-only
 * `info`, then the samples. The result is published back to `signalInfo`.
 */
export async function loadInfo(item: StudioItem, opts: { reader?: string; sampleRate?: number } = {}): Promise<RecordInfo> {
  const hit = getRuntime<RecordInfo>(item.id, "signalInfo");
  if (hit?.header !== undefined) return hit;
  const reader = readerFor(item, opts.reader);
  const fromHeader = await reader.info?.(item);
  if (fromHeader) {
    publish(item.id, "signalInfo", fromHeader);
    return fromHeader;
  }
  if (hit) return hit;
  const info = infoOf(await reader.read(item, opts));
  publish(item.id, "signalInfo", info);
  return info;
}
