import type { ExporterImpl, InspectFn, ModuleImpl } from "@studio/plugin-ui-sdk/module";
import { TableGrid, loadTable } from "./grid";
import { labeledCsv, rowsOf } from "./table";

const inspect: InspectFn = (a) => {
  const rows = rowsOf(a);
  const out: [string, string][] = [["Rows", rows.length > 8 ? `${rows.slice(0, 8).map((r) => r + 1).join(", ")}… (${rows.length})` : rows.map((r) => r + 1).join(", ")]];
  if (a.attributes?.column) out.push(["Column", String(a.attributes.column)]);
  return out;
};

const csv: ExporterImpl = {
  filename: (p) => `${p.id}-labeled.csv`,
  async build({ items, annotations }) {
    const files = await Promise.all(items.map(async (i) => ({ id: i.id, table: await loadTable(i.assets[0].path).catch(() => null) })));
    return new Blob([labeledCsv(files, annotations)], { type: "text/csv" });
  },
};

export default { renderers: { grid: TableGrid }, inspectors: { rows: inspect }, exporters: { "labeled-csv": csv } } satisfies ModuleImpl;
