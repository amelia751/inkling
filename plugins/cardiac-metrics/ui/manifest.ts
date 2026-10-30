import { defineModule } from "@studio/plugin-ui-sdk/module";
import { CINE } from "@plugins/cine/manifest";
import { MetricsConfigSchema } from "./config";
import { CARDIAC } from "./ids";

/**
 * Cardiac function on top of inkling.cine: include it in a cardiac environment, leave it
 * out for any other slice × frame data. Structure roles (rv / myo / lv) come from the cine
 * renderer's `structures` config.
 */
export default defineModule({
  id: CARDIAC,
  version: "1.0.0",
  title: "Cardiac function metrics",
  description: "EDV, ESV, SV, EF, LV mass and Dice vs reference for a cardiac cine (Simpson's method of discs), as a right panel and a CSV export.",
  requires: [CINE],
  contributes: {
    panels: [
      {
        id: "metrics",
        title: "Function",
        slot: "right",
        configSchema: MetricsConfigSchema,
        description: "Ventricular volumes and function, LV mass, the volume curve with an ED/ES suggestion, per-slice areas, Dice vs reference and body size",
        example: { panels: { right: [`${CARDIAC}.panels.metrics`] } },
      },
    ],
    exporters: [
      {
        id: "function-csv",
        label: "Cardiac function (CSV)",
        accepts: ["spline", "polygon", "mask"],
        description: "Per-frame, per-slice RV/MYO/LV areas and volumes, plus EDV, ESV, SV, EF and LV mass (Simpson's method of discs).",
      },
    ],
  },
  load: () => import("./impl"),
});
