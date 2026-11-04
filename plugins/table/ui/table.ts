import type { Annotation } from "@studio/contracts/types";

/** A parsed table: header plus string cells (no type inference; the grid shows text). */
export interface Table {
  columns: string[];
  rows: string[][];
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a trailing newline is not a row. */
export function parseCsv(text: string, delimiter = ","): Table {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), out.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field !== "" || row.length) row.push(field), out.push(row);
  const [columns = [], ...rows] = out.filter((r) => !(r.length === 1 && r[0] === ""));
  return { columns, rows };
}

const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsvLine = (cells: string[]) => cells.map(esc).join(",");

/** `attributes.rows` is a comma-separated list of 0-based data-row indices. */
export const formatRows = (rows: number[]) => [...new Set(rows)].sort((a, b) => a - b).join(",");
export function rowsOf(a: Annotation): number[] {
  const r = a.attributes?.rows;
  if (typeof r === "number") return [r];
  if (typeof r !== "string" || !r) return [];
  return r.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0);
}
export const isRowLabel = (a: Annotation) => a.geometry.type === "class" && a.attributes?.rows !== undefined;

/** Row → labels on that row, for one item. */
export function rowLabels(annotations: Annotation[], itemId: string): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const a of annotations) {
    if (a.itemId !== itemId || !isRowLabel(a)) continue;
    for (const r of rowsOf(a)) {
      const ls = m.get(r) ?? [];
      if (!ls.includes(a.label)) ls.push(a.label);
      m.set(r, ls);
    }
  }
  return m;
}

/** Rows that carry more than one distinct label, per item: `[itemId, row, labels, annotationIds]`. */
export function disagreements(annotations: Annotation[]): { itemId: string; row: number; labels: string[]; annotationIds: string[] }[] {
  const by = new Map<string, { labels: Set<string>; ids: Set<string> }>();
  for (const a of annotations) {
    if (!isRowLabel(a)) continue;
    for (const r of rowsOf(a)) {
      const k = `${a.itemId}\u0000${r}`;
      const e = by.get(k) ?? { labels: new Set(), ids: new Set() };
      e.labels.add(a.label), e.ids.add(a.id);
      by.set(k, e);
    }
  }
  return [...by.entries()]
    .filter(([, e]) => e.labels.size > 1)
    .map(([k, e]) => {
      const [itemId, row] = k.split("\u0000");
      return { itemId, row: Number(row), labels: [...e.labels].sort(), annotationIds: [...e.ids] };
    });
}

/**
 * CSV with labels joined. When every file shares one header: `file,<header…>,label` with every
 * row (label empty when unlabelled, several joined by `;`). Otherwise, and for files the grid
 * can't read, the long form `file,row,label` with one line per labelled row.
 */
export function labeledCsv(files: { id: string; table: Table | null }[], annotations: Annotation[]): string {
  const headers = new Set(files.map((f) => (f.table ? JSON.stringify(f.table.columns) : "")));
  const wide = headers.size === 1 && files.every((f) => f.table);
  if (wide && files.length) {
    const lines = [toCsvLine(["file", ...files[0].table!.columns, "label"])];
    for (const f of files) {
      const labels = rowLabels(annotations, f.id);
      f.table!.rows.forEach((r, i) => lines.push(toCsvLine([f.id, ...r, (labels.get(i) ?? []).join(";")])));
    }
    return lines.join("\n") + "\n";
  }
  const lines = [toCsvLine(["file", "row", "label"])];
  for (const f of files) {
    for (const [row, ls] of [...rowLabels(annotations, f.id)].sort((a, b) => a[0] - b[0])) lines.push(toCsvLine([f.id, String(row), ls.join(";")]));
  }
  return lines.join("\n") + "\n";
}
