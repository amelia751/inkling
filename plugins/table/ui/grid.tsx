import { useEffect, useMemo, useState } from "react";
import { Loader } from "@studio/ui/ui/loader";
import { Button } from "@studio/ui/ui/button";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { labelNames } from "@studio/contracts/environment";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import { assetUrl, newAnnotation, useCommands, useHost, visibleFor } from "@studio/plugin-ui-sdk";
import { TABLE } from "./manifest";
import { formatRows, isRowLabel, parseCsv, rowsOf, type Table } from "./table";

/** Rows drawn at once; larger tables need the Perspective / DuckDB follow-up. */
const MAX_ROWS = 2000;

interface Selection {
  rows: number[];
  column?: string;
  anchor?: number;
}

const range = (a: number, b: number) => Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => Math.min(a, b) + i);

/** Load one tabular asset. CSV/TSV parse here; columnar formats need a reader (follow-up). */
export async function loadTable(path: string): Promise<Table | null> {
  const lower = path.toLowerCase();
  if (!lower.endsWith(".csv") && !lower.endsWith(".tsv")) return null;
  const r = await fetch(assetUrl(path));
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const text = await r.text();
  return parseCsv(text, lower.endsWith(".tsv") ? "\t" : ",");
}

/**
 * Row grid for one table item. Click selects a row (Shift extends, ⌘/Ctrl toggles); with the
 * Rows tool a click labels at once. Enter labels the selection with the active class. Labels
 * are core `class` annotations carrying `attributes.rows`.
 */
export function TableGrid({ item, project, runtime }: RendererProps) {
  const [table, setTable] = useState<Table | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>({ rows: [] });
  const annotations = useHost((s) => s.annotations);
  const hidden = useHost((s) => s.hiddenLabels);
  const selectedIds = useHost((s) => s.selectedIds);
  const tool = useHost((s) => s.tool);
  const labels = labelNames(project.labels);
  const path = item.assets[0].path;

  useEffect(() => {
    let live = true;
    setTable(undefined), setError(null), setSel({ rows: [] });
    loadTable(path)
      .then((t) => live && setTable(t))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [path]);

  const rowAnns = useMemo(() => visibleFor(annotations, item.id, hidden).filter(isRowLabel), [annotations, item.id, hidden]);
  const byRow = useMemo(() => {
    const m = new Map<number, typeof rowAnns>();
    for (const a of rowAnns) for (const r of rowsOf(a)) m.set(r, [...(m.get(r) ?? []), a]);
    return m;
  }, [rowAnns]);

  useEffect(() => {
    runtime.publish("selection", { rows: sel.rows, column: sel.column ?? null });
  }, [sel, runtime]);
  useEffect(() => {
    if (!table) return;
    useHost.getState().setViewerStatus(`${table.rows.length.toLocaleString()} rows · ${table.columns.length} columns · ${rowAnns.length} labels`);
    runtime.publish("tableStats", { rows: table.rows.length, columns: table.columns.length, labels: rowAnns.length });
  }, [table, rowAnns.length, runtime]);

  const label = (rows: number[], column?: string) => {
    const st = useHost.getState();
    if (!rows.length || !st.activeLabel) return false;
    const ann = newAnnotation({ itemId: item.id, label: st.activeLabel, geometry: { type: "class" }, attributes: { rows: formatRows(rows), ...(column ? { column } : {}) } });
    st.add(ann);
    st.select(ann.id);
    return true;
  };

  useCommands(
    {
      labelRows: () => (sel.rows.length ? void label(sel.rows, sel.column) : false),
      clearRows: () => (sel.rows.length ? void setSel({ rows: [] }) : false),
    },
    { scope: TABLE },
  );

  const onCell = (e: React.MouseEvent, row: number, column?: string) => {
    const extend = e.shiftKey && sel.anchor !== undefined;
    const toggle = e.metaKey || e.ctrlKey;
    let rows: number[];
    if (extend) rows = range(sel.anchor!, row);
    else if (toggle) rows = sel.rows.includes(row) ? sel.rows.filter((r) => r !== row) : [...sel.rows, row];
    else rows = [row];
    const col = !extend && !toggle ? column : sel.column === column ? column : undefined;
    if (tool === "rows" && label(extend ? rows : [row], col)) return setSel({ rows: [], anchor: row });
    setSel({ rows, column: col, anchor: extend ? sel.anchor : row });
    const hits = byRow.get(row);
    if (hits?.length && !toggle && !extend) useHost.getState().select(hits[hits.length - 1].id);
  };

  if (error) return <div className="p-6 text-sm text-muted-foreground">Couldn't load this table: {error}</div>;
  if (table === undefined) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader size="s" /> Loading</div>;
  if (table === null)
    return (
      <div className="p-6 text-sm text-muted-foreground" data-testid="table-grid-unsupported">
        This file is columnar (Parquet or Arrow). The grid reads CSV for now; a columnar reader is coming.
      </div>
    );

  const shown = table.rows.slice(0, MAX_ROWS);
  const selected = new Set(sel.rows);
  return (
    <div className="flex h-full flex-col bg-background" data-testid="table-grid">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <span data-testid="table-selection">{sel.rows.length ? `${sel.rows.length} selected${sel.column ? ` · ${sel.column}` : ""}` : "Click a row to select it"}</span>
        {sel.rows.length > 0 && (
          <Button size="sm" variant="secondary" className="h-6" data-testid="table-label-rows" onClick={() => label(sel.rows, sel.column)}>
            Label rows
          </Button>
        )}
        {table.rows.length > MAX_ROWS && <span className="ml-auto">Showing first {MAX_ROWS.toLocaleString()} of {table.rows.length.toLocaleString()} rows</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse text-xs tabular-nums">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="w-12 border-b border-r px-2 py-1 text-right font-medium text-muted-foreground">#</th>
              <th className="w-28 border-b border-r px-2 py-1 text-left font-medium text-muted-foreground">Label</th>
              {table.columns.map((c, i) => (
                <th key={i} className="border-b border-r px-2 py-1 text-left font-medium text-foreground">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const anns = byRow.get(i) ?? [];
              const active = anns.some((a) => selectedIds.includes(a.id));
              const top = anns[anns.length - 1];
              return (
                <tr
                  key={i}
                  data-row={i}
                  data-selected={selected.has(i) || undefined}
                  className={selected.has(i) ? "bg-accent" : "hover:bg-muted/50"}
                  style={top ? { boxShadow: `inset 3px 0 0 ${labelColor(labels, top.label)}`, background: selected.has(i) ? undefined : labelColor(labels, top.label, active ? 0.28 : 0.12) } : undefined}
                >
                  <td className="cursor-pointer select-none border-b border-r px-2 py-1 text-right text-muted-foreground" onClick={(e) => onCell(e, i)}>{i + 1}</td>
                  <td className="border-b border-r px-2 py-1" data-testid="table-row-label" title={anns.map((a) => a.label).join(", ")}>
                    {[...new Set(anns.map((a) => a.label))].join(", ")}
                  </td>
                  {r.map((v, j) => (
                    <td key={j} className="cursor-pointer select-none whitespace-nowrap border-b border-r px-2 py-1" onClick={(e) => onCell(e, i, table.columns[j])}>{v}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
