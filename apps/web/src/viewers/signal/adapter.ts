import type { Annotation } from "@/types";
import type { ViewerAdapter } from "@/viewers/ViewerAdapter";
import { beatCodeName, rhythmName, statementForCode } from "./codes";
import { signalExporters } from "./exporters";
import { cachedInfo } from "./record";
import { SignalViewer } from "./SignalViewer";

const sec = (t: number) => `${t.toFixed(3)} s`;
const msec = (t: number) => `${Math.round(t * 1000)} ms`;
const leadText = (lead: string) => (lead === "all" ? "All leads" : lead);

function provenanceRows(a: Annotation): [string, string][] {
  const rows: [string, string][] = [];
  const src = a.attributes?.source;
  if (src) rows.push(["Source", src === "pan-tompkins" ? `Pan–Tompkins (lead ${a.attributes?.lead ?? "II"})` : String(src)]);
  if (a.provenance !== "human-created") rows.push(["Provenance", a.provenance === "ai-suggested" ? "AI suggestion · unreviewed" : "AI, corrected"]);
  return rows;
}

/** Inspector rows for ECG geometries: times in s and ms, sample index, lead, code. */
function inspect(a: Annotation, ctx: { item: { id: string } }): [string, string][] {
  const fs = cachedInfo(ctx.item.id)?.fs;
  const smp = (t: number) => (fs ? ` · #${Math.round(t * fs)}` : "");
  const g = a.geometry;
  let rows: [string, string][] = [];
  switch (g.type) {
    case "beat":
      rows = [
        ["Code", `${g.code} — ${beatCodeName(g.code)}`],
        ["Time", `${sec(g.t)}${smp(g.t)}`],
        ["Lead", leadText(g.lead)],
      ];
      break;
    case "wave":
      rows = [
        ["Wave", g.wave],
        ["Lead", leadText(g.lead)],
        ["Onset", `${sec(g.onset)}${smp(g.onset)}`],
        ...(g.peak !== undefined ? ([["Peak", `${sec(g.peak)}${smp(g.peak)}`]] as [string, string][]) : []),
        ["Offset", `${sec(g.offset)}${smp(g.offset)}`],
        ["Duration", msec(g.offset - g.onset)],
      ];
      break;
    case "interval":
      rows = [
        ["Lead", leadText(g.lead)],
        ["Start", `${sec(g.start)}${smp(g.start)}`],
        ["End", `${sec(g.end)}${smp(g.end)}`],
        ["Duration", msec(g.end - g.start)],
      ];
      break;
    case "rhythm":
      rows = [
        ["Rhythm", `${g.rhythm} — ${rhythmName(g.rhythm)}`],
        ["Start", `${sec(g.start)}${smp(g.start)}`],
        ["End", `${sec(g.end)}${smp(g.end)}`],
        ["Duration", `${(g.end - g.start).toFixed(2)} s`],
      ];
      break;
    case "class": {
      const code = a.attributes?.snomed;
      if (code) rows = [["SNOMED CT", `${code}${statementForCode(String(code)) ? "" : " (unmapped)"}`]];
      break;
    }
  }
  return [...rows, ...provenanceRows(a)];
}

export const signalAdapter: ViewerAdapter = {
  kind: "signal",
  tools: ["select", "pan", "interval", "beat", "wave", "rhythm", "caliper"],
  Component: SignalViewer,
  inspect,
  exporters: signalExporters,
};
