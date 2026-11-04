# Table

Tabular data (CSV today; Parquet and Arrow are matched but need a columnar reader) on a row grid.

- Data kind `studio.table.dataKinds.table`: one item per file.
- Renderer `studio.table.renderers.grid`: click a row (Shift for a range, ⌘/Ctrl to toggle).
  The selection is published as runtime key `selection` (`{ rows, column }`).
- Tool `studio.table.tools.rows`: with it active, a click or Shift-click labels the rows with the
  active class at once. In any tool, Enter (`labelRows`) labels the current selection.
- A row label is an annotation `{ geometry: { type: "class" }, attributes: { rows: "3,4,5" } }`
  (0-based data-row indices, comma-separated; `column` is set when a single cell was picked).
- Review rule `row-label-disagreement`; exporter `labeled-csv`.

Follow-ups: Perspective (pivots, large tables), Parquet/Arrow readers (DuckDB-WASM through
`runtime`), a Parquet exporter.
