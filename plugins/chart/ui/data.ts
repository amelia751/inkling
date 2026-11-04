/**
 * Pure table helpers for the chart kit: delimited text to rows, and rows to chart points.
 * No chart library here, so it stays importable from the manifest side and unit tests.
 */
import type { SeriesConfig } from "./config";

export type Cell = string | number | null;
export interface Table {
  columns: string[];
  rows: Record<string, Cell>[];
}

export function parseDelimited(text: string): Table {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (!lines.length) return { columns: [], rows: [] };
  const head = lines[0];
  const sep = head.includes("\t") && !head.includes(",") ? "\t" : (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ";" : ",";
  const split = (l: string) => l.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
  const columns = split(head);
  const rows = lines.slice(1).map((l) => {
    const cells = split(l);
    const row: Record<string, Cell> = {};
    columns.forEach((c, i) => {
      const raw = cells[i] ?? "";
      const n = Number(raw);
      row[c] = raw === "" ? null : Number.isFinite(n) ? n : raw;
    });
    return row;
  });
  return { columns, rows };
}

/** A time cell in epoch seconds, or null when it can't be read. */
export function toSeconds(v: Cell, unit: SeriesConfig["timeUnit"]): number | null {
  if (v == null) return null;
  if (typeof v === "number") return unit === "ms" || (unit === "auto" && Math.abs(v) > 1e11) ? v / 1000 : v;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

export type Mode = "candles" | "lines";
export interface Point {
  time: number;
  value: number;
}
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface Prepared {
  mode: Mode;
  lines: { name: string; points: Point[] }[];
  bars: Bar[];
  volume: Point[];
  times: number[];
}

const num = (v: Cell): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Rows sorted by time with duplicate times dropped (the chart needs strictly ascending time). */
export function prepare(table: Table, cfg: SeriesConfig): Prepared {
  const timed = table.rows
    .map((r) => ({ r, t: toSeconds(r[cfg.time] ?? null, cfg.timeUnit) }))
    .filter((x): x is { r: Record<string, Cell>; t: number } => x.t != null)
    .sort((a, b) => a.t - b.t)
    .filter((x, i, a) => i === 0 || x.t !== a[i - 1].t);
  const times = timed.map((x) => x.t);
  const candleCols = [cfg.open, cfg.high, cfg.low, cfg.close];
  const candles = candleCols.every(Boolean);
  const bars: Bar[] = [];
  if (candles) {
    for (const { r, t } of timed) {
      const [o, h, l, c] = candleCols.map((k) => num(r[k!] ?? null));
      if (o != null && h != null && l != null && c != null) bars.push({ time: t, open: o, high: h, low: l, close: c });
    }
  }
  const skip = new Set([cfg.time, ...candleCols, cfg.volume].filter(Boolean) as string[]);
  const valueCols = cfg.value.length ? cfg.value : candles ? [] : table.columns.filter((c) => !skip.has(c) && table.rows.some((r) => num(r[c] ?? null) != null));
  const lines = valueCols.map((name) => ({
    name,
    points: timed.flatMap(({ r, t }) => {
      const v = num(r[name] ?? null);
      return v == null ? [] : [{ time: t, value: v }];
    }),
  }));
  const volume = cfg.volume ? timed.flatMap(({ r, t }) => (num(r[cfg.volume!] ?? null) == null ? [] : [{ time: t, value: num(r[cfg.volume!] ?? null)! }])) : [];
  return { mode: candles ? "candles" : "lines", lines, bars, volume, times };
}

/** A Vega-Lite spec with the item's rows as inline data when the spec brings none. */
export function withRows(spec: Record<string, unknown>, rows: Record<string, Cell>[]): Record<string, unknown> {
  return spec.data ? spec : { ...spec, data: { values: rows } };
}

/** The data time nearest to t (clicks snap to rows). */
export function nearest(times: number[], t: number): number | null {
  if (!times.length) return null;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t) ? times[lo - 1] : times[lo];
}
