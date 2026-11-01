import * as z from "zod";
import { WaveformIcon } from "@studio/ui/icons";
import { tool } from "@studio/renderers/tool-catalog";
import { defineModule } from "@studio/plugin-ui-sdk/module";
import type { Project, StudioItem } from "@studio/contracts/types";
import { MeasurementsConfigSchema, StripChartConfigSchema, TIMESERIES } from "./config";
import { geometries } from "./geometries";
import { WfdbExportConfigSchema } from "./wfdbCodes";
import { ns } from "@studio/contracts/naming";

export { TIMESERIES } from "./config";
const ON_STRIP = `renderer == ${TIMESERIES}.renderers.strip-chart`;
const KIND = `${TIMESERIES}.dataKinds.multichannel-timeseries`;

const codeOption = (list: string) => z.object({ code: z.string().default("").describe(`Code of new annotations; empty = the first of the strip chart's \`${list}\``) });

function groupItems(project: Project): StudioItem[] {
  return project.assets.map((a) => ({
    id: a.path,
    name: a.record ?? a.path,
    group: "Recordings",
    assets: [a],
    sourceLabel: a.dx,
    dataKind: KIND,
  }));
}

/**
 * Multichannel time series on a strip chart. ECG is a preset (paper grid, 12-lead layout,
 * WFDB vocabulary, SNOMED statements), not the module: the same renderer serves any sampled
 * signal, e.g. an accelerometer CSV on a plain grid.
 */
export default defineModule({
  id: TIMESERIES,
  version: "1.1.0",
  title: "Multichannel time series",
  description: "Sampled signals (WFDB, CSV) on a strip chart: spans and instants per channel, a record-level track, delineation, beat detection and calipers.",
  contributes: {
    dataKinds: [
      {
        id: "multichannel-timeseries",
        label: "Waveform",
        icon: WaveformIcon,
        itemNoun: "recording",
        match: { ext: [".json", ".hea", ".dat", ".csv"] },
        fileKinds: ["waveform"],
        groupItems,
        description: "One item per recording; channels are leads / signals. Read by the strip chart's `reader` (wfdb, csv; EDF next)",
      },
    ],
    renderers: [
      {
        id: "strip-chart",
        consumes: [KIND],
        space: "time",
        capabilities: ["time", "pan", "zoom", "suggestions"],
        description: "Strip chart: stacked or column layouts, ECG paper or plain grid, zero-phase display filters, calipers",
        configSchema: StripChartConfigSchema,
        example: {
          viewports: [
            {
              name: "main",
              renderer: `${TIMESERIES}.renderers.strip-chart`,
              config: { reader: "csv", grid: "plain", unit: "g", track: { channel: "activity", label: "Activity" }, trackCodes: [{ id: "walk" }, { id: "run" }] },
            },
          ],
        },
      },
    ],
    geometries,
    tools: [
      tool("interval", { creates: "span", when: ON_STRIP, description: "Time span on one channel or all (attributes.kind = interval)" }),
      tool("beat", { creates: "instant", when: ON_STRIP, optionsSchema: codeOption("instantCodes"), description: "Instant with a code from `instantCodes` (attributes.kind = beat, .code)" }),
      tool("wave", { creates: "span", when: ON_STRIP, description: "Wave onset / peak / offset (attributes.kind = wave, .wave, .peak)" }),
      tool("rhythm", { creates: "span", when: ON_STRIP, optionsSchema: codeOption("trackCodes"), description: "Episode on the record-level track (attributes.kind = rhythm, .rhythm)" }),
      tool("caliper", { when: ON_STRIP, description: "Measure Δt and Δamplitude (not saved)" }),
    ],
    commands: [
      {
        id: "scrollWindow",
        keys: ["ArrowLeft", "ArrowRight", "shift+ArrowLeft", "shift+ArrowRight"],
        display: "← → (⇧ page)",
        label: "Scroll the time window",
        group: "Navigate",
        repeat: true,
        shadows: [ns("core.commands.prevItem"), ns("core.commands.nextItem")],
        description: "Scroll the visible time window",
      },
      { id: "zoomTime", keys: ["=", "+", "-"], display: "+ / −", label: "Zoom time (paper: speed)", group: "View", repeat: true, description: "Zoom the time axis" },
      {
        id: "setBeatCode",
        keys: [],
        label: "Set code of selected instants",
        group: "Labels",
        contextual: true,
        description: "Set the code whose `hotkey` (strip-chart `instantCodes`) was pressed on the selected instants; bind the same keys to this command",
        example: { keybindings: [{ command: `${TIMESERIES}.commands.setBeatCode`, keys: ["shift+n", "shift+v"] }] },
      },
      { id: "clearCaliper", keys: ["Escape"], label: "Clear caliper / close menu", group: "Drawing", contextual: true, description: "Clear the caliper" },
      {
        id: "detectBeats",
        label: "Detect beats (Pan–Tompkins)",
        group: "Labels",
        description: "R-peak detection on the primary (or focused) channel; results are ai-suggested instants for review. Needs strip-chart config `ecg: true`",
      },
      { id: "calibrateScreen", label: "Calibrate screen for paper scale", group: "View", description: "Match an on-screen bar to a credit card so mm/s and mm per unit are true (grid: ecg)" },
    ],
    panels: [
      {
        id: "measurements",
        title: "Measurements",
        slot: "right",
        configSchema: MeasurementsConfigSchema,
        description: "Rate and RR from instants, wave intervals (ecg), track episodes and record statements (a `multiple` Choices group)",
      },
    ],
    inspectors: [{ id: "main", geometries: ["span", "instant", "class"], description: "Times in s and ms, sample index (runtime.signalInfo), channel, code names and statement codes" }],
    exporters: [
      {
        id: "wfdb-atr",
        label: "WFDB annotations (.tar)",
        accepts: ["span", "instant", "class"],
        configSchema: WfdbExportConfigSchema,
        description:
          "MIT-format <record>.atr (beats, rhythm changes, noise) plus LUDB-style per-lead wave files (<record>.i, .ii … with ( peak ) triplets), the source .hea headers and a RECORDS list. Readable with rdann / wfdb-python.",
      },
      {
        id: "ecg-json",
        label: "ECG delineation (LUDB JSON)",
        accepts: ["span", "instant", "class"],
        description: "Per record: beats, P/QRS/T waves (onset/peak/offset), rhythm episodes, intervals and record statements, in seconds and sample indices.",
      },
      {
        id: "ecg-intervals-csv",
        label: "Intervals & waves (CSV)",
        accepts: ["span"],
        description: "One row per interval, wave and rhythm episode: record, kind, lead, label, start/end in s and samples, duration in ms, provenance.",
      },
    ],
  },
  load: () => import("./impl"),
});
