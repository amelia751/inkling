import { ChartIcon, EventIcon, IntervalIcon } from "@studio/ui/icons";
import { defineModule } from "@studio/plugin-ui-sdk/module";
import type { Project, StudioItem } from "@studio/contracts/types";
import { assetName } from "@studio/plugin-ui-sdk/assets";
import { CHART, SERIES_KIND, SeriesConfigSchema, SpecConfigSchema, TABLE_KIND } from "./config";

export { CHART, SERIES_KIND, TABLE_KIND } from "./config";

const ON_SERIES = `renderer == ${CHART}.renderers.series`;

function groupItems(project: Project): StudioItem[] {
  return project.assets.map((a) => ({ id: a.path, name: assetName(a), group: "Tables", assets: [a], dataKind: SERIES_KIND }));
}

/**
 * Charts over tabular rows: a time-series / candle chart (Lightweight Charts) with window and
 * event annotations, and a Vega-Lite spec renderer. Domain-neutral: which columns mean what
 * comes from renderer config in a preset.
 */
export default defineModule({
  id: CHART,
  version: "0.1.0",
  title: "Charts",
  description: "Time-series lines and open/high/low/close candles over table rows, Vega-Lite specs, and window (span) and event (instant) annotations on the time axis.",
  contributes: {
    dataKinds: [
      {
        id: "series",
        label: "Time-ordered table",
        icon: ChartIcon,
        itemNoun: "table",
        match: { ext: [".csv", ".tsv"] },
        groupItems,
        description: "One item per delimited text file whose rows carry a time column; the table kit's `table` kind is also accepted by the chart renderers",
      },
    ],
    renderers: [
      {
        id: "series",
        consumes: [SERIES_KIND, TABLE_KIND],
        space: "time",
        capabilities: ["time", "pan", "zoom"],
        description: "Time-series lines ({time, value[]}) or candles ({time, open, high, low, close}, optional volume) drawn with Lightweight Charts",
        configSchema: SeriesConfigSchema,
        example: { viewports: [{ name: "main", renderer: `${CHART}.renderers.series`, config: { time: "time", open: "open", high: "high", low: "low", close: "close", volume: "volume" } }] },
      },
      {
        id: "spec",
        consumes: [SERIES_KIND, TABLE_KIND],
        space: "time",
        capabilities: [],
        description: "Any Vega-Lite chart: a JSON spec in config, with the item's rows injected as data when the spec has none",
        configSchema: SpecConfigSchema,
        example: {
          viewports: [
            { name: "main", renderer: `${CHART}.renderers.spec`, config: { spec: { mark: "bar", encoding: { x: { field: "time", type: "temporal" }, y: { field: "value", type: "quantitative" } } } } },
          ],
        },
      },
    ],
    tools: [
      {
        id: "window",
        label: "Window",
        hint: "Click the start, then the end, of a time window on the chart. Esc cancels",
        icon: IntervalIcon,
        group: "time",
        hotkey: "i",
        creates: "span",
        when: ON_SERIES,
        description: "Time window or regime as a core `span` (attributes.kind = window)",
      },
      {
        id: "event",
        label: "Event",
        hint: "Click a time on the chart to mark an event",
        icon: EventIcon,
        group: "time",
        hotkey: "t",
        creates: "instant",
        when: ON_SERIES,
        description: "Point-in-time event as a core `instant` (attributes.kind = event)",
      },
    ],
    commands: [
      { id: "fitAll", keys: ["Home"], label: "Fit all data", group: "View", when: ON_SERIES, description: "Zoom the time axis to show every row" },
      { id: "cancelWindow", keys: ["Escape"], label: "Cancel the open window", group: "Drawing", contextual: true, description: "Drop the window whose start was clicked but not its end" },
    ],
  },
  load: () => import("./impl"),
});
