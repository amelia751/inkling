/**
 * Composition root: the only file that knows which modules ship in this build. The shell
 * reaches modules only through the registry (enforced by tools/check-boundaries.mjs).
 * Adding a module = one import and one entry in MODULES.
 */
import { defineModule, type ModuleManifest, type PresetContribution } from "@studio/plugin-ui-sdk/module";
import { registry } from "./registry";
import { resolveDefaults } from "./resolve";
import cornerstone from "@studio/renderers/cornerstone/manifest";
import overlay2d from "@studio/renderers/overlay2d/manifest";
import timeline from "@studio/renderers/timeline/manifest";
import cardiacMetrics from "@plugins/cardiac-metrics/manifest";
import cine from "@plugins/cine/manifest";
import core from "@/studio/core/manifest";
import dicomExport from "@plugins/dicom-export/manifest";
import image2d from "@plugins/image2d/manifest";
import timeseries from "@plugins/timeseries/manifest";
import video from "@plugins/video/manifest";
import volume from "@plugins/volume/manifest";
import wsi from "@plugins/wsi/manifest";
import textSpans from "@plugins/text-spans/manifest";
import experimental from "./agent-panels/manifest";
import { featureEnabled } from "./flags";
import { declarativeModule } from "./contributions-loader";
import { registerTrustedRenderer } from "./trusted-renderers";
import { MaskReview, MaskReviewConfig } from "@studio/renderers/mask-review/MaskReview";
import { PLUGIN_PACKAGES } from "./manifests";
// Binds the plugin host API (useHost, assetUrl, commands) before any plugin code runs.
import "./host";
import { ns } from "@studio/contracts/naming";

/** Presets are environment JSON only (registry/presets/*.json), registered as one module. */
const presetFiles = import.meta.glob<PresetContribution>("../../../../registry/presets/*.json", { eager: true, import: "default" });
export const presets = defineModule({
  id: ns("presets"),
  version: "1.0.0",
  title: "Presets",
  description: "Ready-made environments: the six medical Studios and generic starting points. Use with `extends`.",
  contributes: { presets: Object.values(presetFiles).sort((a, b) => a.id.localeCompare(b.id)) },
});

/** Studio built-ins: always present, not plugins (no plugin.yaml, never installed per workspace). */
export const BUILTIN_MODULES: ModuleManifest[] = [core, overlay2d, cornerstone, timeline, presets];

// Trusted renderers shipped with the build that declarative plugins may name (fail closed otherwise).
registerTrustedRenderer("studio.mask-review.v1", { component: MaskReview, configSchema: MaskReviewConfig, description: "Review AI-suggested masks: accept, reject or edit each instance" });

/**
 * Plugins without trusted code of their own: `plugins/<name>/plugin.yaml` + `ui/contributions.json`
 * only, turned into contributions on trusted renderers (contributions-loader.tsx).
 */
export const DECLARATIVE_MODULES: ModuleManifest[] = PLUGIN_PACKAGES.packages
  .filter((p) => !p.manifest.ui?.module && p.contributions)
  .map((p) => declarativeModule(p.manifest, p.contributions!));
if (PLUGIN_PACKAGES.problems.length && import.meta.env?.DEV) console.warn("[plugins] invalid plugin manifests (not registered):", PLUGIN_PACKAGES.problems);

export const MODULES: ModuleManifest[] = [core, overlay2d, cornerstone, timeline, image2d, volume, timeseries, video, cine, cardiacMetrics, wsi, dicomExport, textSpans, ...DECLARATIVE_MODULES, presets];

for (const m of MODULES) registry.registerModule(m);
// Agent-generated panels (safety tiers 2–3) exist only when the agentPanels flag is on.
if (featureEnabled("agentPanels")) registry.registerModule(experimental);
// Built-ins are active in every workspace; plugins only where the workspace activated them
// (extension-host/workspace.ts). Until a workspace is applied, everything bundled is active.
registry.pin([...BUILTIN_MODULES.map((m) => m.id), ...(featureEnabled("agentPanels") ? [experimental.id] : [])]);
// Every environment gets the Studio core, whatever it references.
resolveDefaults.baseModules = [core.id];
