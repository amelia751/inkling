import { encodeAtr, ustar, type AtrAnnotation, type TarEntry } from "@/kits/io/wfdb";
import type { ExportContext, ExporterImpl } from "@/platform/module";
import { registry } from "@/platform/registry";
import { resolveEnvironment, type ResolvedEnv } from "@/platform/resolve";
import type { Annotation, StudioItem } from "@/types";
import { stripConfig, TIMESERIES } from "./config";
import { channelOf, codeOf, kindOf, ownAttributes, peakOf, rangeOf, rhythmOf, waveOf, type Kind } from "./model";
import { loadInfo, type RecordInfo } from "./readers";
import { WfdbExportConfigSchema } from "./wfdbCodes";

/**
 * WFDB / LUDB / CSV exports of span and instant annotations. They read the stored v2 form
 * (model.ts) and write exactly the files the v1 geometries produced: `lead` keys, v1
 * `attributes` (the migration's own keys stripped), same rows and samples.
 */

const signalAnns = (ctx: ExportContext, item: StudioItem) => ctx.annotations.filter((a) => a.itemId === item.id);
/** LUDB names its per-lead annotation files by the lower-cased lead: i, ii, avr, v1 … */
const leadExt = (lead: string) => lead.toLowerCase();

/** The environment the export runs in: the caller's, else the project's own. */
function envOf(ctx: ExportContext): ResolvedEnv | undefined {
  return ctx.env ?? (ctx.project.environment ? resolveEnvironment(ctx.project.environment, registry).env : undefined);
}

async function infos(ctx: ExportContext) {
  const cfg = stripConfig(envOf(ctx));
  const items = ctx.items.filter((it) => ctx.annotations.some((a) => a.itemId === it.id));
  return Promise.all(items.map(async (item) => ({ item, info: await loadInfo(item, { reader: cfg.reader, sampleRate: cfg.sampleRate }) })));
}

function chanOf(info: RecordInfo, order: string[], lead: string) {
  if (lead === "all") return 0;
  const i = info.channels.indexOf(lead);
  return i >= 0 ? i : Math.max(0, order.indexOf(lead));
}

type Typed = { a: Annotation; kind: Kind; channel: string; start: number; end: number };
function typed(anns: Annotation[]): Typed[] {
  const out: Typed[] = [];
  for (const a of anns) {
    const kind = kindOf(a);
    const r = rangeOf(a.geometry);
    if (kind && r) out.push({ a, kind, channel: channelOf(a.geometry), start: r[0], end: r[1] });
  }
  return out;
}

/**
 * Reference annotations for one record in MIT format:
 * - beats → their WFDB code (unknown → Q), CHN = channel index (0 for "all");
 * - rhythm episodes → RHYTHM (+) at the start with the aux string, e.g. "(AFIB". WFDB rhythms
 *   last until the next rhythm annotation, so an episode end with no following episode is lost;
 * - noise intervals (label matches `noise`) → NOISE (~) with subtype −1 (all signals
 *   unreadable) for "all" or 1 on the channel, and ~ with subtype 0 (clean) at the end.
 */
function atrFor(anns: Annotation[], info: RecordInfo, order: string[], codes: Record<string, number>, noise: RegExp): AtrAnnotation[] {
  const out: AtrAnnotation[] = [];
  const s = (t: number) => Math.round(t * info.fs);
  for (const x of typed(anns)) {
    if (x.kind === "beat") out.push({ sample: s(x.start), code: codes[codeOf(x.a)] ?? codes.Q ?? 13, chan: chanOf(info, order, x.channel) });
    else if (x.kind === "rhythm") out.push({ sample: s(x.start), code: codes["+"] ?? 28, aux: rhythmOf(x.a), chan: 0 });
    else if (x.kind === "interval" && noise.test(x.a.label)) {
      const chan = chanOf(info, order, x.channel);
      out.push({ sample: s(x.start), code: codes["~"] ?? 14, sub: x.channel === "all" ? -1 : 1, chan });
      out.push({ sample: s(x.end), code: codes["~"] ?? 14, sub: 0, chan });
    }
  }
  return out;
}

/** LUDB-style per-lead delineation: "(" onset, p / N / t at the peak, ")" offset. */
function waveFiles(anns: Annotation[], info: RecordInfo, order: string[], codes: Record<string, number>): Map<string, AtrAnnotation[]> {
  const byLead = new Map<string, AtrAnnotation[]>();
  const s = (t: number) => Math.round(t * info.fs);
  const peakCode: Record<string, number> = { P: codes.p ?? 24, QRS: codes.N ?? 1, T: codes.t ?? 27 };
  for (const x of typed(anns)) {
    if (x.kind !== "wave") continue;
    const leads = x.channel === "all" ? info.channels : [x.channel];
    const peak = peakOf(x.a);
    for (const lead of leads) {
      const list = byLead.get(lead) ?? [];
      const chan = chanOf(info, order, lead);
      list.push({ sample: s(x.start), code: codes["("] ?? 39, chan });
      list.push({ sample: s(peak ?? (x.start + x.end) / 2), code: peakCode[waveOf(x.a)] ?? codes.N ?? 1, chan });
      list.push({ sample: s(x.end), code: codes[")"] ?? 40, chan });
      byLead.set(lead, list);
    }
  }
  return byLead;
}

const wfdbExporter: ExporterImpl = {
  filename: (p) => `${p.id}-wfdb.tar`,
  build: async (ctx) => {
    const env = envOf(ctx);
    const order = stripConfig(env).channelOrder;
    const cfg = WfdbExportConfigSchema.parse(env?.configs[`${TIMESERIES}.exporters.wfdb-atr`] ?? {});
    const noise = new RegExp(cfg.noise, "i");
    const enc = new TextEncoder();
    const files: TarEntry[] = [];
    const records: string[] = [];
    const exts = new Set<string>(["atr"]);
    for (const { item, info } of await infos(ctx)) {
      const anns = signalAnns(ctx, item);
      records.push(info.record);
      files.push({ name: `${info.record}.atr`, data: encodeAtr(atrFor(anns, info, order, cfg.codes, noise)) });
      for (const [lead, list] of waveFiles(anns, info, order, cfg.codes)) {
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

const ludbExporter: ExporterImpl = {
  filename: (p) => `${p.id}-ecg.json`,
  build: async (ctx) => {
    const records = (await infos(ctx)).map(({ item, info }) => {
      const anns = signalAnns(ctx, item);
      const all = typed(anns);
      const smp = (t: number) => Math.round(t * info.fs);
      const base = (a: Annotation) => {
        const attributes = ownAttributes(a);
        return { id: a.id, label: a.label, provenance: a.provenance, author: a.author, ...(attributes ? { attributes } : {}) };
      };
      const pick = (k: Kind) => all.filter((x) => x.kind === k);
      return {
        record: info.record,
        fs: info.fs,
        samples: info.samples,
        leads: info.channels,
        beats: pick("beat").map((x) => ({ ...base(x.a), lead: x.channel, code: codeOf(x.a), t: x.start, sample: smp(x.start) })),
        waves: pick("wave").map((x) => {
          const peak = peakOf(x.a);
          return {
            ...base(x.a),
            lead: x.channel,
            wave: waveOf(x.a),
            onset: x.start,
            peak: peak ?? null,
            offset: x.end,
            onset_sample: smp(x.start),
            peak_sample: peak === undefined ? null : smp(peak),
            offset_sample: smp(x.end),
          };
        }),
        rhythms: pick("rhythm").map((x) => ({ ...base(x.a), rhythm: rhythmOf(x.a), start: x.start, end: x.end, start_sample: smp(x.start), end_sample: smp(x.end) })),
        intervals: pick("interval").map((x) => ({ ...base(x.a), lead: x.channel, start: x.start, end: x.end, start_sample: smp(x.start), end_sample: smp(x.end) })),
        statements: anns.filter((a) => a.geometry.type === "class").map((a) => ({ ...base(a), snomed: a.attributes?.snomed ?? null })),
      };
    });
    return json({ project: ctx.project.id, format: "inkling-ecg/1 (LUDB-style)", exportedAt: new Date().toISOString(), records });
  },
};

const csvCell = (v: string | number) => (typeof v === "number" ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const csvExporter: ExporterImpl = {
  filename: (p) => `${p.id}-intervals.csv`,
  build: async (ctx) => {
    const rows: (string | number)[][] = [["record", "kind", "lead", "label", "start_s", "end_s", "duration_ms", "start_sample", "end_sample", "provenance"]];
    for (const { item, info } of await infos(ctx)) {
      for (const x of typed(signalAnns(ctx, item))) {
        let r: [string, string] | null = null;
        if (x.kind === "interval") r = ["interval", x.channel];
        else if (x.kind === "wave") r = [`wave:${waveOf(x.a)}`, x.channel];
        else if (x.kind === "rhythm") r = [`rhythm:${rhythmOf(x.a)}`, "all"];
        if (!r) continue;
        const [kind, lead] = r;
        rows.push([info.record, kind, lead, x.a.label, x.start, x.end, Math.round((x.end - x.start) * 1000), Math.round(x.start * info.fs), Math.round(x.end * info.fs), x.a.provenance]);
      }
    }
    return new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n"], { type: "text/csv" });
  },
};

export const exporters: Record<string, ExporterImpl> = { "wfdb-atr": wfdbExporter, "ecg-json": ludbExporter, "ecg-intervals-csv": csvExporter };
