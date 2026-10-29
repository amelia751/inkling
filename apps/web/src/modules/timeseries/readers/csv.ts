import { seedUrl } from "@/lib/api";
import type { Recording, SignalReader } from "./types";

/**
 * CSV recordings (accelerometers, loggers…): a header row, an optional time column and one
 * numeric column per channel. The time column is the first one named t / time / timestamp /
 * seconds (`…_ms` / `ms` columns are milliseconds); without one, `sampleRate` gives the rate.
 * Samples are assumed uniform: fs = 1 / median Δt. Blank or non-numeric cells read as NaN.
 */
const TIME = /^(t|time|timestamp|seconds|sec|secs|time_s|t_s|elapsed|ms|time_ms|t_ms|timestamp_ms)$/i;

export function parseCsv(text: string, opts: { record: string; sampleRate?: number }): Recording {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!lines.length) throw new Error("empty CSV");
  const sep = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ";" : lines[0].includes("\t") && !lines[0].includes(",") ? "\t" : ",";
  const split = (l: string) => l.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
  const first = split(lines[0]);
  const hasHeader = first.some((c) => c !== "" && Number.isNaN(Number(c)));
  const names = hasHeader ? first : first.map((_, i) => `ch${i + 1}`);
  const rows = (hasHeader ? lines.slice(1) : lines).map((l) => split(l).map((c) => (c === "" ? NaN : Number(c))));
  const timeCol = hasHeader ? names.findIndex((n) => TIME.test(n)) : -1;
  const channels = names.map((n, i) => ({ n, i })).filter(({ i }) => i !== timeCol);
  const data: Record<string, Float32Array> = {};
  for (const { n, i } of channels) data[n] = Float32Array.from(rows, (r) => r[i]);
  let fs = opts.sampleRate;
  if (timeCol >= 0) {
    const scale = /ms$/i.test(names[timeCol]) ? 1000 : 1;
    const t = rows.map((r) => r[timeCol] / scale);
    const dt = t.slice(1).map((v, i) => v - t[i]).filter((d) => d > 0).sort((a, b) => a - b);
    if (dt.length) fs = 1 / dt[dt.length >> 1];
  }
  if (!fs || !Number.isFinite(fs)) throw new Error("CSV has no time column; set the strip chart's sampleRate");
  return { record: opts.record, fs: +fs.toFixed(6), samples: rows.length, channels: channels.map((c) => c.n), data };
}

export const csvReader: SignalReader = {
  id: "csv",
  accepts: (path) => /\.(csv|tsv|txt)$/i.test(path),
  async read(item, { signal, sampleRate }) {
    const path = item.assets[0].path;
    const res = await fetch(seedUrl(path), { signal });
    if (!res.ok) throw new Error(`${res.status}`);
    const record = (item.assets[0] as { record?: string }).record ?? path.split("/").pop()!.replace(/\.[^.]+$/, "");
    return parseCsv(await res.text(), { record, sampleRate });
  },
};
