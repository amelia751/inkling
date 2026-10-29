import type { Annotation, Geometry, Project, StudioItem } from "@/types";
import type { Exporter, ExportContext } from "@/viewers/ViewerAdapter";
import { STANDARD_LEADS, WFDB_CODE_BY_SYMBOL } from "./codes";
import { loadInfo, type RecordInfo } from "./record";
import { encodeAtr, ustar, type AtrAnnotation, type TarEntry } from "@/kits/io/wfdb";

type G<T extends Geometry["type"]> = Extract<Geometry, { type: T }>;

const signalAnns = (ctx: ExportContext, item: StudioItem) => ctx.annotations.filter((a) => a.itemId === item.id);
const isNoise = (label: string) => /artifact|artefact|noise/i.test(label);
/** LUDB names its per-lead annotation files by the lower-cased lead: i, ii, avr, v1 … */
const leadExt = (lead: string) => lead.toLowerCase();
const chanOf = (info: RecordInfo, lead: string) => {
  if (lead === "all") return 0;
  const i = info.leadNames.indexOf(lead);
  return i >= 0 ? i : Math.max(0, STANDARD_LEADS.indexOf(lead));
};

async function infos(ctx: ExportContext) {
  const items = ctx.items.filter((it) => ctx.annotations.some((a) => a.itemId === it.id));
  return Promise.all(items.map(async (item) => ({ item, info: await loadInfo(item) })));
}

/**
 * Reference annotations for one record in MIT format:
 * - beats → their WFDB code (unknown letters → Q), CHN = lead index (0 for "all");
 * - rhythm episodes → RHYTHM (+) at the start with the aux string, e.g. "(AFIB". WFDB rhythms
 *   last until the next rhythm annotation, so an episode end with no following episode is lost;
 * - "artifact"/noise intervals → NOISE (~) with subtype −1 (all signals unreadable) for "all" or 1
 *   on the lead's channel, and ~ with subtype 0 (clean) at the end.
 */
function atrFor(anns: Annotation[], info: RecordInfo): AtrAnnotation[] {
  const out: AtrAnnotation[] = [];
  const s = (t: number) => Math.round(t * info.fs);
  for (const a of anns) {
    const g = a.geometry;
    if (g.type === "beat") out.push({ sample: s(g.t), code: WFDB_CODE_BY_SYMBOL.get(g.code)?.code ?? 13, chan: chanOf(info, g.lead) });
    else if (g.type === "rhythm") out.push({ sample: s(g.start), code: 28, aux: g.rhythm, chan: 0 });
    else if (g.type === "interval" && isNoise(a.label)) {
      const chan = chanOf(info, g.lead);
      out.push({ sample: s(g.start), code: 14, sub: g.lead === "all" ? -1 : 1, chan });
      out.push({ sample: s(g.end), code: 14, sub: 0, chan });
    }
  }
  return out;
}

/** LUDB-style per-lead delineation: "(" onset, p / N / t at the peak, ")" offset. */
function waveFiles(anns: Annotation[], info: RecordInfo): Map<string, AtrAnnotation[]> {
  const byLead = new Map<string, AtrAnnotation[]>();
  const s = (t: number) => Math.round(t * info.fs);
  const peakCode = { P: 24, QRS: 1, T: 27 } as const;
  for (const a of anns) {
    const g = a.geometry;
    if (g.type !== "wave") continue;
    const leads = g.lead === "all" ? info.leadNames : [g.lead];
    for (const lead of leads) {
      const list = byLead.get(lead) ?? [];
      const chan = chanOf(info, lead);
      list.push({ sample: s(g.onset), code: 39, chan });
      list.push({ sample: s(g.peak ?? (g.onset + g.offset) / 2), code: peakCode[g.wave], chan });
      list.push({ sample: s(g.offset), code: 40, chan });
      byLead.set(lead, list);
    }
  }
  return byLead;
}

const wfdbExporter: Exporter = {
  id: "wfdb-atr",
  label: "WFDB annotations (.tar)",
  description:
    "MIT-format <record>.atr (beats, rhythm changes, noise) plus LUDB-style per-lead wave files (<record>.i, .ii … with ( peak ) triplets), the source .hea headers and a RECORDS list. Readable with rdann / wfdb-python.",
  filename: (p: Project) => `${p.id}-wfdb.tar`,
  build: async (ctx) => {
    const enc = new TextEncoder();
    const files: TarEntry[] = [];
    const records: string[] = [];
    const exts = new Set<string>(["atr"]);
    for (const { item, info } of await infos(ctx)) {
      const anns = signalAnns(ctx, item);
      records.push(info.record);
      files.push({ name: `${info.record}.atr`, data: encodeAtr(atrFor(anns, info)) });
      for (const [lead, list] of waveFiles(anns, info)) {
        exts.add(leadExt(lead));
        files.push({ name: `${info.record}.${leadExt(lead)}`, data: encodeAtr(list) });
      }
      if (info.header) files.push({ name: `${info.record}.hea`, data: enc.encode(info.header) });
    }
    files.push({ name: "RECORDS", data: enc.encode(records.map((r) => `${r}\n`).join("")) });
    const annotators = [...exts].map((x) => (x === "atr" ? "atr\treference beat, rhythm and signal quality annotations" : `${x}\tP/QRS/T delineation, lead ${x.toUpperCase()}`));
    files.push({ name: "ANNOTATORS", data: enc.encode(annotators.join("\n") + "\n") });
    return new Blob([ustar(files) as BlobPart], { type: "application/x-tar" });
  },
};

const json = (o: unknown) => new Blob([JSON.stringify(o, null, 2)], { type: "application/json" });

const ludbExporter: Exporter = {
  id: "ecg-json",
  label: "ECG delineation (LUDB JSON)",
  description: "Per record: beats, P/QRS/T waves (onset/peak/offset), rhythm episodes, intervals and record statements, in seconds and sample indices.",
  filename: (p) => `${p.id}-ecg.json`,
  build: async (ctx) => {
    const records = (await infos(ctx)).map(({ item, info }) => {
      const anns = signalAnns(ctx, item);
      const smp = (t: number) => Math.round(t * info.fs);
      const base = (a: Annotation) => ({ id: a.id, label: a.label, provenance: a.provenance, author: a.author, ...(a.attributes ? { attributes: a.attributes } : {}) });
      const pick = <T extends Geometry["type"]>(type: T) => anns.filter((a): a is Annotation & { geometry: G<T> } => a.geometry.type === type);
      return {
        record: info.record,
        fs: info.fs,
        samples: info.samples,
        leads: info.leadNames,
        beats: pick("beat").map((a) => ({ ...base(a), lead: a.geometry.lead, code: a.geometry.code, t: a.geometry.t, sample: smp(a.geometry.t) })),
        waves: pick("wave").map((a) => ({
          ...base(a),
          lead: a.geometry.lead,
          wave: a.geometry.wave,
          onset: a.geometry.onset,
          peak: a.geometry.peak ?? null,
          offset: a.geometry.offset,
          onset_sample: smp(a.geometry.onset),
          peak_sample: a.geometry.peak === undefined ? null : smp(a.geometry.peak),
          offset_sample: smp(a.geometry.offset),
        })),
        rhythms: pick("rhythm").map((a) => ({ ...base(a), rhythm: a.geometry.rhythm, start: a.geometry.start, end: a.geometry.end, start_sample: smp(a.geometry.start), end_sample: smp(a.geometry.end) })),
        intervals: pick("interval").map((a) => ({ ...base(a), lead: a.geometry.lead, start: a.geometry.start, end: a.geometry.end, start_sample: smp(a.geometry.start), end_sample: smp(a.geometry.end) })),
        statements: pick("class").map((a) => ({ ...base(a), snomed: a.attributes?.snomed ?? null })),
      };
    });
    return json({ project: ctx.project.id, format: "inkling-ecg/1 (LUDB-style)", exportedAt: new Date().toISOString(), records });
  },
};

const csvCell = (v: string | number) => (typeof v === "number" ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const csvExporter: Exporter = {
  id: "ecg-intervals-csv",
  label: "Intervals & waves (CSV)",
  description: "One row per interval, wave and rhythm episode: record, kind, lead, label, start/end in s and samples, duration in ms, provenance.",
  filename: (p) => `${p.id}-intervals.csv`,
  build: async (ctx) => {
    const rows: (string | number)[][] = [["record", "kind", "lead", "label", "start_s", "end_s", "duration_ms", "start_sample", "end_sample", "provenance"]];
    for (const { item, info } of await infos(ctx)) {
      for (const a of signalAnns(ctx, item)) {
        const g = a.geometry;
        let r: [string, string, number, number] | null = null;
        if (g.type === "interval") r = ["interval", g.lead, g.start, g.end];
        else if (g.type === "wave") r = [`wave:${g.wave}`, g.lead, g.onset, g.offset];
        else if (g.type === "rhythm") r = [`rhythm:${g.rhythm}`, "all", g.start, g.end];
        if (!r) continue;
        const [kind, lead, s0, s1] = r;
        rows.push([info.record, kind, lead, a.label, s0, s1, Math.round((s1 - s0) * 1000), Math.round(s0 * info.fs), Math.round(s1 * info.fs), a.provenance]);
      }
    }
    return new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n"], { type: "text/csv" });
  },
};

export const signalExporters: Exporter[] = [wfdbExporter, ludbExporter, csvExporter];
