/**
 * Composition root: the only file that knows which modules ship in this build. The shell
 * reaches modules only through the registry (enforced by scripts/check-boundaries.mjs).
 * Adding a module = one import and one entry in MODULES.
 */
import { defineModule, type ModuleManifest, type PresetContribution } from "@studio/plugin-ui-sdk/module";
import { registry } from "./registry";
import { resolveDefaults } from "./resolve";
import cornerstone from "@studio/studio-renderers/cornerstone/manifest";
import overlay2d from "@studio/studio-renderers/overlay2d/manifest";
import timeline from "@studio/studio-renderers/timeline/manifest";
import cardiacMetrics from "@plugins/cardiac-metrics/manifest";
import cine from "@plugins/cine/manifest";
import core from "@/studio/core/manifest";
import dicomExport from "@plugins/export-dicom/manifest";
import image2d from "@plugins/image2d/manifest";
import timeseries from "@plugins/timeseries/manifest";
import video from "@plugins/video/manifest";
import volume from "@plugins/volume/manifest";
import wsi from "@plugins/wsi/manifest";
import textSpans from "@plugins/text-spans/manifest";
import experimental from "./agent-panels/manifest";
import { featureEnabled } from "./flags";
// Binds the plugin host API (useHost, assetUrl, commands) before any plugin code runs.
import "./host";
import { ns } from "@studio/plugin-contracts/naming";

/** Presets are environment JSON only (registry/presets/*.json), registered as one module. */
const presetFiles = import.meta.glob<PresetContribution>("../../../../registry/presets/*.json", { eager: true, import: "default" });
export const presets = defineModule({
  id: ns("presets"),
  version: "1.0.0",
  title: "Presets",
  description: "Ready-made environments: the six medical Studios and generic starting points. Use with `extends`.",
  contributes: { presets: Object.values(presetFiles).sort((a, b) => a.id.localeCompare(b.id)) },
});

export const MODULES: ModuleManifest[] = [core, overlay2d, cornerstone, timeline, image2d, volume, timeseries, video, cine, cardiacMetrics, wsi, dicomExport, textSpans, presets];

for (const m of MODULES) registry.registerModule(m);
// Agent-generated panels (safety tiers 2–3) exist only when the agentPanels flag is on.
if (featureEnabled("agentPanels")) registry.registerModule(experimental);
// Every environment gets the Studio core, whatever it references.
resolveDefaults.baseModules = [core.id];
