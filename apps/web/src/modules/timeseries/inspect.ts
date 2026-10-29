import type { InspectFn } from "@/platform/module";
import type { Annotation } from "@/types";
import { codeName, measurementsConfig, statementsOf, stripConfig, type StripChartConfig } from "./config";
import { channelOf, codeOf, kindOf, peakOf, rangeOf, rhythmOf, waveOf } from "./model";
import type { RecordInfo } from "./readers";

const sec = (t: number) => `${t.toFixed(3)} s`;
const msec = (t: number) => `${Math.round(t * 1000)} ms`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Lead" / "All leads" (or "Channel" / "All channels") for a channel value. */
export function channelText(cfg: Pick<StripChartConfig, "channelNoun">, channel: string): string {
  return channel === "all" ? `All ${cfg.channelNoun}s` : channel;
}

function provenanceRows(a: Annotation): [string, string][] {
  const rows: [string, string][] = [];
  const src = a.attributes?.source;
  if (src) rows.push(["Source", src === "pan-tompkins" ? `Pan–Tompkins (lead ${a.attributes?.lead ?? "II"})` : String(src)]);
  if (a.provenance !== "human-created") rows.push(["Provenance", a.provenance === "ai-suggested" ? "AI suggestion · unreviewed" : "AI, corrected"]);
  return rows;
}

/**
 * Inspector rows for spans and instants on a strip chart: times in s and ms, the sample
 * index (from `runtime.signalInfo`), channel, codes with their names from the config
 * vocabulary, and item-level statements with their code.
 */
export const inspect: InspectFn = (a, ctx) => {
  const cfg = stripConfig(ctx.env);
  const fs = ctx.runtime.get<RecordInfo>("signalInfo")?.fs;
  const smp = (t: number) => (fs ? ` · #${Math.round(t * fs)}` : "");
  const Ch = cap(cfg.channelNoun);
  const g = a.geometry;
  const kind = kindOf(a, cfg.track.channel);
  const r = rangeOf(g);
  let rows: [string, string][] = [];
  if (kind && r) {
    const [start, end] = r;
    const ch = channelText(cfg, channelOf(g));
    switch (kind) {
      case "beat":
        rows = [
          ["Code", `${codeOf(a)} — ${codeName(cfg.instantCodes, codeOf(a))}`],
          ["Time", `${sec(start)}${smp(start)}`],
          [Ch, ch],
        ];
        break;
      case "wave": {
        const peak = peakOf(a);
        rows = [
          ["Wave", waveOf(a)],
          [Ch, ch],
          ["Onset", `${sec(start)}${smp(start)}`],
          ...(peak !== undefined ? ([["Peak", `${sec(peak)}${smp(peak)}`]] as [string, string][]) : []),
          ["Offset", `${sec(end)}${smp(end)}`],
          ["Duration", msec(end - start)],
        ];
        break;
      }
      case "interval":
        rows = [
          [Ch, ch],
          ["Start", `${sec(start)}${smp(start)}`],
          ["End", `${sec(end)}${smp(end)}`],
          ["Duration", msec(end - start)],
        ];
        break;
      case "rhythm":
        rows = [
          [cfg.track.label, `${rhythmOf(a)} — ${codeName(cfg.trackCodes, rhythmOf(a))}`],
          ["Start", `${sec(start)}${smp(start)}`],
          ["End", `${sec(end)}${smp(end)}`],
          ["Duration", `${(end - start).toFixed(2)} s`],
        ];
        break;
    }
  } else if (g.type === "class") {
    const pc = measurementsConfig(ctx.env);
    const code = a.attributes?.[pc.codeAttribute];
    if (code !== undefined) {
      const known = statementsOf(ctx.env, pc).items.some((s) => s.code === String(code));
      rows = [[pc.codeSystem ?? cap(pc.codeAttribute), `${code}${known ? "" : " (unmapped)"}`]];
    }
  }
  return [...rows, ...provenanceRows(a)];
};
