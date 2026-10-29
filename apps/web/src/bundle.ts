/**
 * Composition root: the only file that knows which modules ship in this build. The shell
 * reaches modules only through the registry (enforced by scripts/check-boundaries.mjs).
 * Adding a module = one import and one entry in MODULES.
 */
import { defineModule, type ModuleManifest, type PresetContribution } from "@/platform/module";
import { registry } from "@/platform/registry";
import { resolveDefaults } from "@/platform/resolve";
import cornerstone from "@/kits/cornerstone/manifest";
import overlay2d from "@/kits/overlay2d/manifest";
import timeline from "@/kits/timeline/manifest";
import cardiacMetrics from "@/modules/cardiac-metrics/manifest";
import cine from "@/modules/cine/manifest";
import core from "@/modules/core/manifest";
import dicomExport from "@/modules/dicom-export/manifest";
import image2d from "@/modules/image2d/manifest";
import timeseries from "@/modules/timeseries/manifest";
import video from "@/modules/video/manifest";
import volume from "@/modules/volume/manifest";
import wsi from "@/modules/wsi/manifest";
import textSpans from "@/modules/text-spans/manifest";
import experimental from "@/modules/experimental/manifest";
import { featureEnabled } from "@/platform/flags";

/** Presets are environment JSON only (platform/presets/*.json), registered as one module. */
const presetFiles = import.meta.glob<PresetContribution>("./platform/presets/*.json", { eager: true, import: "default" });
export const presets = defineModule({
  id: "inkling.presets",
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
