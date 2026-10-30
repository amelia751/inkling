import type { StudioItem } from "@studio/contracts/types";

/** A loaded multichannel recording: one Float32Array of samples per channel, uniformly sampled at `fs`. */
export interface Recording {
  record: string;
  fs: number;
  samples: number;
  channels: string[];
  data: Record<string, Float32Array>;
  /** Source label of the recording (e.g. a comma-separated list of diagnosis codes). */
  dx?: string;
}

/** Record geometry without the samples: what exporters and the inspector need (`runtime.signalInfo`). */
export interface RecordInfo {
  record: string;
  fs: number;
  samples: number;
  channels: string[];
  /** Raw WFDB header text, when the source ships one (copied into WFDB exports). */
  header?: string;
}

/**
 * How one file format becomes a Recording. Add a format by writing a reader and listing it in
 * `readers/index.ts` (EDF is the next one: header + 16-bit records, see edfplus.info).
 */
export interface SignalReader {
  id: string;
  /** Whether this reader understands an item's first asset (by extension). */
  accepts: (path: string) => boolean;
  read: (item: StudioItem, opts: { signal?: AbortSignal; sampleRate?: number }) => Promise<Recording>;
  /** Record geometry without downloading the samples, when the format allows it. */
  info?: (item: StudioItem) => Promise<RecordInfo | undefined>;
}

export const infoOf = (r: Recording): RecordInfo => ({ record: r.record, fs: r.fs, samples: r.samples, channels: r.channels });
