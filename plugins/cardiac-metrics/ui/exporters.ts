import { fetchBodySize } from "@studio/studio-renderers/io/niftiIO";
import { labelNames } from "@studio/plugin-contracts/environment";
import type { ExporterImpl } from "@studio/plugin-ui-sdk/module";
import type { Project } from "@studio/plugin-contracts/types";
import { cineConfigFor, cineGridFor, cinePath, frameCoverage, pickCineItem, resolvePhases, STRUCT_KEYS, structuresOf } from "@plugins/cine/public";
import { MetricsConfigSchema } from "./config";
import { computeMetrics, mosteller } from "./metrics";
import { PANEL_ID } from "./ids";

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !isFinite(v) ? "" : v.toFixed(d));

export const metricsExporters: Record<string, ExporterImpl> = {
  "function-csv": {
    filename: (p: Project) => `${p.id}_function.csv`,
    build: async ({ project, items, annotations, env }) => {
      const item = pickCineItem(items, annotations);
      const { grid } = await cineGridFor(item);
      const labels = labelNames(project.labels);
      const structures = structuresOf(cineConfigFor(env, project));
      const { phases: ids } = MetricsConfigSchema.parse(env?.configs[PANEL_ID] ?? {});
      const phases = resolvePhases(annotations, item.id, item.assets, project.meta, [ids.ed, ids.es]);
      const body = await fetchBodySize(cinePath(item)!, project.meta);
      const bsa = mosteller(body.height, body.weight);
      const frames = frameCoverage({ annotations, itemId: item.id, labels, structures, grid });
      const m = computeMetrics({ frames, ed: phases[ids.ed]?.frame ?? null, es: phases[ids.es]?.frame ?? null, bsa });
      const rows: string[] = ["section,item,frame,phase,slice,rv_area_mm2,myo_area_mm2,lv_area_mm2"];
      const phaseOf = (f: number) => (f === m.ed ? "ED" : f === m.es ? "ES" : "");
      for (const fm of m.frames) {
        for (const [z, a] of [...fm.areas.entries()].sort((x, y) => x[0] - y[0]))
          rows.push(["area", item.id, fm.frame + 1, phaseOf(fm.frame), z + 1, fmt(a.rv), fmt(a.myo), fmt(a.lv)].join(","));
      }
      rows.push("", "section,item,frame,phase,rv_volume_ml,myo_volume_ml,lv_volume_ml,rv_status,myo_status,lv_status");
      for (const fm of m.frames) {
        if (STRUCT_KEYS.every((k) => fm.volume[k] === null)) continue;
        rows.push(["volume", item.id, fm.frame + 1, phaseOf(fm.frame), fmt(fm.volume.rv), fmt(fm.volume.myo), fmt(fm.volume.lv), fm.status.rv, fm.status.myo, fm.status.lv].join(","));
      }
      const idx = (v: number | null) => (v !== null && bsa ? v / bsa : null);
      rows.push(
        "",
        "metric,value,unit",
        `ED frame,${m.ed !== null ? m.ed + 1 : ""},`,
        `ES frame,${m.es !== null ? m.es + 1 : ""},`,
        `slice spacing,${fmt(grid.spacing[2])},mm`,
        `pixel spacing,${fmt(grid.spacing[0], 4)}x${fmt(grid.spacing[1], 4)},mm`,
        `height,${fmt(body.height, 1)},cm`,
        `weight,${fmt(body.weight, 1)},kg`,
        `BSA (Mosteller),${fmt(bsa, 3)},m2`,
      );
      for (const [k, f] of [["LV", m.lv], ["RV", m.rv]] as const) {
        rows.push(`${k} EDV,${fmt(f.edv)},mL`, `${k} ESV,${fmt(f.esv)},mL`, `${k} SV,${fmt(f.sv)},mL`, `${k} EF,${fmt(f.ef, 1)},%`);
        rows.push(`${k} EDVi,${fmt(idx(f.edv))},mL/m2`, `${k} ESVi,${fmt(idx(f.esv))},mL/m2`);
      }
      rows.push(`LV mass (ED),${fmt(m.mass)},g`, `LV mass index,${fmt(idx(m.mass))},g/m2`);
      for (const w of m.warnings) rows.push(`warning,"${w.replace(/"/g, "'")}",`);
      return new Blob([rows.join("\n") + "\n"], { type: "text/csv" });
    },
  },
};
