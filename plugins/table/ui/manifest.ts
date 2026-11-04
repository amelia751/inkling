import { FileIcon, TagIcon } from "@studio/ui/icons";
import { defineModule, type ReviewRuleContribution } from "@studio/plugin-ui-sdk/module";
import type { Project, StudioItem } from "@studio/contracts/types";
import { ns } from "@studio/contracts/naming";
import { assetName } from "@studio/plugin-ui-sdk/assets";
import { disagreements } from "./table";

/**
 * Tabular files on a row grid. A row (or cell) label is a core `class` annotation with the
 * rows in `attributes.rows` (see table.ts), so exports, review and the agent read it without
 * knowing this module. Domain vocabulary lives in presets, never here.
 */
export const TABLE = ns("table");
export const TABLE_KIND = `${TABLE}.dataKinds.table` as const;

function groupItems(project: Project): StudioItem[] {
  return project.assets.map((a) => ({ id: a.path, name: assetName(a), group: "Tables", assets: [a], sourceLabel: a.label, dataKind: TABLE_KIND }));
}

const rowLabelDisagreement: ReviewRuleContribution = {
  id: "row-label-disagreement",
  description: "Flags table rows that carry more than one distinct label",
  applies: { geometry: ["class"] },
  check: ({ annotations }) => {
    const d = disagreements(annotations);
    if (!d.length) return [];
    return [
      {
        message: `${d.length} row${d.length === 1 ? "" : "s"} carry conflicting labels (${d.slice(0, 3).map((x) => `row ${x.row + 1}: ${x.labels.join(" vs ")}`).join("; ")}${d.length > 3 ? "…" : ""}).`,
        annotationIds: [...new Set(d.flatMap((x) => x.annotationIds))],
        itemIds: [...new Set(d.map((x) => x.itemId))],
      },
    ];
  },
};

export default defineModule({
  id: TABLE,
  version: "0.1.0",
  title: "Table",
  description: "Tabular files (CSV; Parquet and Arrow matched) on a row grid: label rows or cells, review conflicting row labels, export CSV with labels joined.",
  contributes: {
    dataKinds: [
      {
        id: "table",
        label: "Table",
        icon: FileIcon,
        itemNoun: "table",
        match: { ext: [".csv", ".tsv", ".parquet", ".arrow", ".feather"] },
        fileKinds: ["table"],
        groupItems,
        description: "One item per tabular file (CSV, Parquet or Arrow)",
      },
    ],
    renderers: [
      {
        id: "grid",
        consumes: [TABLE_KIND],
        space: "table",
        capabilities: ["rows"],
        description: "Row grid: click rows to select (Shift range, ⌘ toggle); selection published as runtime `selection`",
      },
    ],
    tools: [
      { id: "rows", label: "Rows", hint: "Click or Shift-click rows to label them with the active class", icon: TagIcon, group: "shape", hotkey: "r", creates: "class", when: "renderer.space == table", description: "Label table rows with a click" },
    ],
    commands: [
      { id: "labelRows", keys: ["Enter"], label: "Label selected rows", group: "Labels", when: "renderer.space == table", description: "Give the selected rows the active class" },
      { id: "clearRows", keys: ["Escape"], label: "Clear row selection", group: "Labels", when: "renderer.space == table", shadows: [ns("core.commands.deselect")], description: "Deselect all rows" },
    ],
    labelControls: [{ id: "RowLabels", geometries: ["class"], description: "Classes for table rows and cells (stored with `attributes.rows`)" }],
    inspectors: [{ id: "rows", geometries: ["class"], description: "Rows and column a row label covers" }],
    reviewRules: [rowLabelDisagreement],
    exporters: [{ id: "labeled-csv", label: "CSV with labels", accepts: ["class"], description: "The table(s) as CSV with a `file` column and a `label` column joined from row labels." }],
  },
  load: () => import("./impl"),
});
