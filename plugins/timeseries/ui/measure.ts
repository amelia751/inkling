import type { Annotation } from "@studio/plugin-contracts/types";
import { channelOf, codeOf, kindOf, peakOf, rangeOf, waveOf } from "./model";

/** A delineated wave, read from its stored span (attributes.wave / attributes.peak). */
interface WaveG {
  lead: string;
  wave: string;
  onset: number;
  peak?: number;
  offset: number;
}

export interface Measurements {
  beats: number;
  hr?: number;
  rrMean?: number;
  rrSd?: number;
  codes: [string, number][];
  unreviewed: number;
  p?: number;
  pr?: number;
  qrs?: number;
  qt?: number;
  qtcB?: number;
  qtcF?: number;
  waves: { P: number; QRS: number; T: number };
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined);

/**
 * Beat times for rhythm measurements: record-level ('all') beats if any, otherwise the lead with
 * the most beats, so a complex annotated on several leads is not counted twice.
 */
export function beatTimes(anns: Annotation[]): number[] {
  const byLead = new Map<string, number[]>();
  for (const a of anns) {
    if (kindOf(a) !== "beat") continue;
    const lead = channelOf(a.geometry);
    const list = byLead.get(lead) ?? [];
    list.push(rangeOf(a.geometry)![0]);
    byLead.set(lead, list);
  }
  let best = byLead.get("all");
  if (!best?.length) for (const l of byLead.values()) if (!best || l.length > best.length) best = l;
  return (best ?? []).sort((a, b) => a - b);
}

export function rrStats(times: number[]) {
  const rr = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0.2 && d < 3);
  const m = mean(rr);
  if (m === undefined) return {};
  const sd = Math.sqrt(rr.reduce((a, b) => a + (b - m) ** 2, 0) / rr.length);
  return { rrMean: m, rrSd: sd, hr: 60 / m };
}

/** RR interval (s) around a time: the beat at/just after `t` and the one before it; mean RR as fallback. */
export function rrAround(times: number[], t: number): number | undefined {
  const k = times.findIndex((b) => b >= t - 0.02);
  if (k > 0 && times[k] - t < 0.2) return times[k] - times[k - 1];
  const before = times.filter((b) => b < t);
  if (before.length >= 2) return before[before.length - 1] - before[before.length - 2];
  return rrStats(times).rrMean;
}

export const bazett = (qt: number, rr: number) => qt / Math.sqrt(rr);
export const fridericia = (qt: number, rr: number) => qt / Math.cbrt(rr);

export function measure(anns: Annotation[]): Measurements {
  const times = beatTimes(anns);
  const { hr, rrMean, rrSd } = rrStats(times);
  const codes = new Map<string, number>();
  let unreviewed = 0;
  const waves: WaveG[] = [];
  for (const a of anns) {
    if (a.provenance === "ai-suggested") unreviewed++;
    const k = kindOf(a);
    if (k === "beat") codes.set(codeOf(a), (codes.get(codeOf(a)) ?? 0) + 1);
    if (k === "wave") {
      const [onset, offset] = rangeOf(a.geometry)!;
      waves.push({ lead: channelOf(a.geometry), wave: waveOf(a), onset, peak: peakOf(a), offset });
    }
  }
  const of = (k: string) => waves.filter((w) => w.wave === k);
  const sameLead = (a: WaveG, b: WaveG) => a.lead === b.lead || a.lead === "all" || b.lead === "all";
  const P = of("P");
  const Q = of("QRS");
  const T = of("T");
  const pr: number[] = [];
  const qt: number[] = [];
  for (const q of Q) {
    const p = P.filter((x) => sameLead(x, q) && x.offset <= q.onset + 0.01 && q.onset - x.onset < 0.4).sort((a, b) => b.onset - a.onset)[0];
    if (p) pr.push(q.onset - p.onset);
    const t = T.filter((x) => sameLead(x, q) && x.onset >= q.offset - 0.01 && x.onset - q.offset < 0.5).sort((a, b) => a.onset - b.onset)[0];
    if (t) qt.push(t.offset - q.onset);
  }
  const qtMean = mean(qt);
  return {
    beats: times.length,
    hr,
    rrMean,
    rrSd,
    codes: [...codes.entries()].sort((a, b) => b[1] - a[1]),
    unreviewed,
    p: mean(P.map((w) => w.offset - w.onset)),
    pr: mean(pr),
    qrs: mean(Q.map((w) => w.offset - w.onset)),
    qt: qtMean,
    qtcB: qtMean !== undefined && rrMean ? bazett(qtMean, rrMean) : undefined,
    qtcF: qtMean !== undefined && rrMean ? fridericia(qtMean, rrMean) : undefined,
    waves: { P: P.length, QRS: Q.length, T: T.length },
  };
}

export const ms = (s: number | undefined) => (s === undefined ? "—" : `${Math.round(s * 1000)} ms`);

