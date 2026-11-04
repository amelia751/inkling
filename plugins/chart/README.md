# Charts (`studio.chart`)

Domain-neutral chart kit (todo23 W1). Which columns mean what comes from renderer config.

- Data kind `series`: one item per CSV / TSV with a time column. The renderers also accept the
  table kit's `studio.table.dataKinds.table`.
- Renderer `series` (Lightweight Charts v5): `{ time, value[] }` draws lines; `{ time, open,
  high, low, close }` draws candles, optional `volume` as a histogram. The footer carries the
  TradingView attribution the licence asks for (see `oss-evaluation.json`).
- Renderer `spec` (vega-embed): a Vega-Lite spec in `config.spec`; the item's rows become
  `data.values` when the spec has no `data`.
- Tools: `window` creates a core `span` (`attributes.kind = "window"`), `event` an `instant`
  (`attributes.kind = "event"`). Commands: `fitAll` (Home), `cancelWindow` (Escape).

```json
{ "extends": "preset:series-chart" }
```
