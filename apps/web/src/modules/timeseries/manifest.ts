import { WaveformIcon } from "@/components/icons";
import { tool } from "@/kits/tool-catalog";
import { defineModule } from "@/platform/module";
import type { Project, StudioItem } from "@/types";

export const TIMESERIES = "inkling.timeseries";
const ON_STRIP = `renderer == ${TIMESERIES}.renderers.strip-chart`;

function groupItems(project: Project): StudioItem[] {
  return project.assets.map((a) => ({
    id: a.path,
    name: a.record ?? a.path,
    group: "Recordings",
    assets: [a],
    sourceLabel: a.dx,
    dataKind: `${TIMESERIES}.dataKinds.multichannel-timeseries`,
  }));
}

/**
 * Multichannel time series on a strip chart. ECG is a preset (paper grid, 12-lead layout,
 * WFDB vocabulary), not the module: the same renderer serves any sampled signal.
 */
export default defineModule({
  id: TIMESERIES,
  version: "1.0.0",
  title: "Multichannel time series",
  description: "Sampled signals (WFDB today) on a strip chart with spans, instants, delineation, beat detection and calipers.",
  contributes: {
    dataKinds: [
      { id: "multichannel-timeseries", label: "Waveform", icon: WaveformIcon, itemNoun: "recording", match: { ext: [".json", ".hea", ".dat"] }, groupItems, description: "One item per recording; channels are leads / signals" },
    ],
    renderers: [
      {
        id: "strip-chart",
        consumes: [`${TIMESERIES}.dataKinds.multichannel-timeseries`],
        space: "time",
        capabilities: ["time", "pan", "zoom", "suggestions"],
        description: "Strip chart: stacked or 12-lead layouts, ECG paper or plain grid, filters, calipers",
      },
    ],
    tools: [
      tool("interval", { creates: "span", when: ON_STRIP, description: "Time span on one channel or all" }),
      tool("beat", { creates: "instant", when: ON_STRIP, description: "Beat fiducial with a code" }),
      tool("wave", { creates: "span", when: ON_STRIP, description: "Wave onset / peak / offset" }),
      tool("rhythm", { creates: "span", when: ON_STRIP, description: "Rhythm episode" }),
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
        shadows: ["inkling.core.commands.prevItem", "inkling.core.commands.nextItem"],
        description: "Scroll the visible time window",
      },
      { id: "zoomTime", keys: ["=", "+", "-"], display: "+ / −", label: "Zoom time (paper: speed)", group: "View", repeat: true, description: "Zoom the time axis" },
      {
        id: "setBeatCode",
        keys: ["shift+n", "shift+v", "shift+a", "shift+l", "shift+r", "shift+f", "shift+j", "shift+s", "shift+e", "shift+q", "shift+b", "/"],
        display: "⇧ N V A L R F J S E Q B · /",
        label: "Set code of selected beats",
        group: "Labels",
        contextual: true,
        description: "Set the code of the selected instants",
      },
      { id: "clearCaliper", keys: ["Escape"], label: "Clear caliper / close menu", group: "Drawing", contextual: true, description: "Clear the caliper" },
    ],
    inspectors: [{ id: "main", geometries: "*", description: "Times in s and ms, sample index, channel, codes and provenance" }],
    exporters: [
      { id: "wfdb-atr", label: "WFDB annotations (.tar)", accepts: ["span", "instant", "interval", "beat", "wave", "rhythm", "class"], description: "MIT-format <record>.atr (beats, rhythm changes, noise) plus LUDB-style per-lead wave files (<record>.i, .ii … with ( peak ) triplets), the source .hea headers and a RECORDS list. Readable with rdann / wfdb-python." },
      { id: "ecg-json", label: "ECG delineation (LUDB JSON)", accepts: ["span", "instant", "interval", "beat", "wave", "rhythm", "class"], description: "Per record: beats, P/QRS/T waves (onset/peak/offset), rhythm episodes, intervals and record statements, in seconds and sample indices." },
      { id: "ecg-intervals-csv", label: "Intervals & waves (CSV)", accepts: ["span", "interval", "wave", "rhythm"], description: "One row per interval, wave and rhythm episode: record, kind, lead, label, start/end in s and samples, duration in ms, provenance." },
    ],
  },
  load: () => import("./impl"),
});
