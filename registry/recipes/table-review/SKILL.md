---
id: table-review
version: 0.1.0
description: "Review and label rows of a tabular dataset (CSV, Parquet, Arrow) in a sortable, filterable grid."
when-to-use: "Data is one or more tables and people need to inspect, filter, flag or categorize rows or cells: ledgers, transactions, survey responses, lab results, inventory, logs exported as CSV."
needs-kinds: [table]
needs-columns: [numeric, category, date, text]
needs-shape: [long, wide, ledger]
limits:
  - "Needs the table plugin (data kind table, renderer grid); it boots only where that plugin is installable."
  - "No charts: add a chart viewport for trends over time."
  - "Row labels only; no cell-level geometry."
requires-plugins: [studio.table]
tier: curated
---

# Table review

A domain-neutral Studio for reviewing rows of a table: one `grid` viewport over the `table`
data kind, where a person sorts, filters and labels rows.

Domain words (label names, column meanings) belong in the project's rules, not
in the plugin.
