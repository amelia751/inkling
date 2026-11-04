import * as z from "zod";
import { ns } from "@studio/contracts/naming";

export const CHART = ns("chart");
/** The table kit's data kind (plugins/table); referenced by id only, never imported. */
export const TABLE_KIND = ns("table.dataKinds.table");
/** This kit's own kind: one item per delimited text file whose rows are ordered by a time column. */
export const SERIES_KIND = `${CHART}.dataKinds.series`;

const column = z.string().min(1);

export const SeriesConfigSchema = z.object({
  time: column.default("time").describe("Column holding the time of each row (ISO date, epoch seconds or epoch ms)"),
  value: z.array(column).default([]).describe("Columns drawn as lines; empty = every numeric column that is not time or a candle column"),
  open: column.optional().describe("Candle mode: column with each bar's first value (set open, high, low and close together)"),
  high: column.optional().describe("Candle mode: column with each bar's highest value"),
  low: column.optional().describe("Candle mode: column with each bar's lowest value"),
  close: column.optional().describe("Candle mode: column with each bar's last value"),
  volume: column.optional().describe("Optional column drawn as a histogram under the main pane"),
  timeUnit: z.enum(["auto", "s", "ms"]).default("auto").describe("Unit of numeric time values; auto treats values above 1e11 as ms"),
});
export type SeriesConfig = z.infer<typeof SeriesConfigSchema>;

export const SpecConfigSchema = z.object({
  spec: z
    .record(z.string(), z.unknown())
    .default({ mark: "line", encoding: { x: { field: "time", type: "temporal" }, y: { field: "value", type: "quantitative" } } })
    .describe("A Vega-Lite JSON spec. Without `data`, the item's rows are injected as `data.values`"),
});
export type SpecConfig = z.infer<typeof SpecConfigSchema>;
