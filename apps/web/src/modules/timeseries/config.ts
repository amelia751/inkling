import * as z from "zod";
import type { ResolvedEnv } from "@/platform/resolve";
import { ns } from "@studio/plugin-contracts/naming";

/**
 * Config of the strip chart and its panel. Every domain value (ECG paper, lead order, WFDB
 * beat codes, rhythms, wave names) is a config value set by a preset (`preset:ecg`); the
 * defaults describe a plain multichannel recording with no vocabulary.
 */
export const TIMESERIES = ns("timeseries");
export const STRIP_CHART = `${TIMESERIES}.renderers.strip-chart`;
export const MEASUREMENTS_PANEL = `${TIMESERIES}.panels.measurements`;

/** One entry of a code vocabulary: the stored value, a display name and an optional hotkey. */
export const CodeSchema = z.object({
  id: z.string().min(1).describe("Value stored in attributes.code (instants) or attributes.rhythm (track spans)"),
  name: z.string().optional().describe("Display name"),
  hotkey: z.string().optional().describe("Combo that sets this code on the selected instants, e.g. \"shift+v\" (bind the same keys to setBeatCode)"),
});
export type Code = z.infer<typeof CodeSchema>;

export const WaveSchema = z.object({
  id: z.string().min(1).describe("Wave name stored in attributes.wave, e.g. P, QRS, T"),
  label: z.string().describe("Label class that delineates this wave"),
});

export const FiltersSchema = z.object({
  hp: z.number().min(0).default(0).describe("High-pass cutoff in Hz (0 = off)"),
  notch: z.number().min(0).default(0).describe("Mains notch in Hz (0 = off)"),
  lp: z.number().min(0).default(0).describe("Low-pass cutoff in Hz (0 = off)"),
});

export const LAYOUTS = ["stacked", "6x2", "3x4", "single"] as const;
export type ConfigLayout = (typeof LAYOUTS)[number];

export const StripChartConfigSchema = z.object({
  reader: z.enum(["auto", "wfdb", "csv"]).default("auto").describe("How assets are read: auto (by extension), wfdb (seed JSON + .hea) or csv (time column + numeric channels)"),
  sampleRate: z.number().positive().optional().describe("CSV without a time column: samples per second"),
  layout: z.enum(LAYOUTS).default("stacked").describe("Initial layout: every channel stacked, 6×2 / 3×4 columns, or one channel"),
  layouts: z.array(z.enum(LAYOUTS)).default(["stacked", "single"]).describe("Layouts offered in the display bar"),
  grid: z.enum(["ecg", "plain"]).default("plain").describe("ecg: 40/200 ms boxes and a true-scale paper mode (mm/s, mm per unit); plain: time ruler only"),
  paperSpeed: z.number().positive().default(25).describe("Initial paper speed, mm/s (grid: ecg)"),
  gain: z.number().positive().default(10).describe("Initial gain, mm per unit"),
  unit: z.string().default("").describe("Amplitude unit of the samples, e.g. mV or g"),
  filters: FiltersSchema.default({ hp: 0, notch: 0, lp: 0 }).describe("Initial display filters (zero-phase; never change stored times)"),
  channelOrder: z.array(z.string()).default([]).describe("Canonical channel order, used for the column layouts and channel numbers in exports"),
  primaryChannel: z.string().optional().describe("Channel of the overview strip, the 3×4 rhythm strip and beat detection; defaults to the first"),
  channelNoun: z.string().default("channel").describe("What a channel is called in the UI (\"lead\" for ECG)"),
  track: z
    .object({ channel: z.string().default("track"), label: z.string().default("Track") })
    .default({ channel: "track", label: "Track" })
    .describe("Record-level span track under the channels; spans on it carry this channel"),
  instantCodes: z.array(CodeSchema).default([]).describe("Codes of instants (beat codes); the first is the default and drawn in the label colour"),
  trackCodes: z.array(CodeSchema).default([]).describe("Codes of track spans (rhythms); the first is the default"),
  waves: z.array(WaveSchema).default([]).describe("Delineated waves and the label class of each; the first non-matching label falls back to `defaultWave`"),
  defaultWave: z.string().optional().describe("Wave drawn when the active label names none of `waves`"),
  instantLabel: z.string().optional().describe("Label class given to new instants (else the active label)"),
  ecg: z.boolean().default(false).describe("ECG extras: Pan–Tompkins beat detection, QT/QTc caliper, heart rate and PR/QRS/QT measurements"),
  displayKey: z.string().default(ns("timeseries.display.v1")).describe("localStorage key for the expert's display settings"),
});
export type StripChartConfig = z.infer<typeof StripChartConfigSchema>;

export const MeasurementsConfigSchema = z.object({
  label: z.string().default("Measurements").describe("Accessible name of the panel"),
  statements: z.string().optional().describe("Choices label group offered as record statements; defaults to the first `multiple` Choices group"),
  codeAttribute: z.string().default("code").describe("Class attribute holding the code that `item.sourceLabel` lists (e.g. snomed)"),
  codeSystem: z.string().optional().describe("Name of that code system, shown in the panel (e.g. SNOMED CT)"),
});
export type MeasurementsConfig = z.infer<typeof MeasurementsConfigSchema>;

/** The strip chart's resolved config in an environment (schema defaults when it has none). */
export function stripConfig(env: ResolvedEnv | null | undefined): StripChartConfig {
  const vp = env?.viewports.find((v) => v.renderer.id === STRIP_CHART);
  return StripChartConfigSchema.parse(vp?.config ?? {});
}

export function parseStripConfig(config: Record<string, unknown> | undefined): StripChartConfig {
  return StripChartConfigSchema.parse(config ?? {});
}

/** Display name of a code ("N" → "Normal beat"), the code itself when unknown. */
export const codeName = (codes: Code[], id: string) => codes.find((c) => c.id === id)?.name ?? id;

export interface Statement {
  /** Class id: the annotation label. */
  id: string;
  /** Short display name. */
  name: string;
  /** Value of the class's code attribute (its default), e.g. a SNOMED CT code. */
  code?: string;
}

/** The record-statement vocabulary: classes of the configured (or first multiple) Choices group. */
export function statementsOf(env: ResolvedEnv | null | undefined, pc: MeasurementsConfig): { group?: string; items: Statement[] } {
  const groups = (env?.labels ?? []).filter((g) => g.control === "Choices");
  const g = pc.statements ? groups.find((x) => x.name === pc.statements) : groups.find((x) => x.multiple);
  if (!g) return { items: [] };
  const items = g.classes.map((c) => {
    const d = c.attributes?.[pc.codeAttribute]?.default;
    return { id: c.id, name: c.name ?? c.id, ...(d !== undefined ? { code: String(d) } : {}) };
  });
  return { group: g.name, items };
}

export const measurementsConfig = (env: ResolvedEnv | null | undefined) => MeasurementsConfigSchema.parse(env?.configs[MEASUREMENTS_PANEL] ?? {});
