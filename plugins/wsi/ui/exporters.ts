import type { ExportContext, ExporterImpl } from "@studio/plugin-ui-sdk/module";
import { toAsapXml, toCountsCsv, toQuPathGeoJSON } from "./io";

const blob = (text: string, type: string) => new Blob([text], { type });

/** `studio.wsi.exporters.*` (labels, descriptions and `accepts` are in manifest.ts). */
export const exporters: Record<string, ExporterImpl> = {
  "qupath-geojson": {
    filename: (p) => `${p.id}-qupath.geojson`,
    build: async ({ project, items, annotations }: ExportContext) => blob(JSON.stringify(toQuPathGeoJSON(project, items, annotations)), "application/geo+json"),
  },
  "asap-xml": {
    filename: (p) => `${p.id}-asap.xml`,
    build: async ({ project, items, annotations }: ExportContext) => blob(toAsapXml(project, items, annotations), "application/xml"),
  },
  "point-counts-csv": {
    filename: (p) => `${p.id}-counts.csv`,
    build: async ({ project, items, annotations }: ExportContext) => blob(toCountsCsv(project, items, annotations), "text/csv"),
  },
};
