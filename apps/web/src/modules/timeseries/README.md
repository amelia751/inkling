# Multichannel time series (`inkling.timeseries`)

Sampled signals on a strip chart. Data kind `multichannel-timeseries` (one item per
recording) is read by a **reader** chosen with the renderer's `reader` config: `wfdb` (seed
JSON + `.hea` header, `readers/wfdb.ts`) or `csv` (time column + numeric channels,
`readers/csv.ts`); EDF is the next reader (`readers/index.ts`). Annotations are core
geometries: `span` / `instant` with a `channel` (`"all"` = every channel) and the domain
vocabulary in `attributes` (`kind`: interval | beat | wave | rhythm; `code`, `wave`, `peak`,
`rhythm`), exactly as the v1→v2 migration writes them (`model.ts`). The strip chart's
`grid: "ecg"` gives ECG paper and true paper scale; ECG itself — lead order, WFDB beat
codes, rhythms, P/QRS/T waves, Pan–Tompkins (`ecg: true`), SNOMED record statements as a
`multiple` Choices group — is `preset:ecg`, not code. The renderer publishes
`runtime.signalInfo` (`{ record, fs, samples, channels }`) for the inspector and exporters.
Commands: `scrollWindow`, `zoomTime`, `setBeatCode` (keys bound by the environment to the
`instantCodes` hotkeys), `clearCaliper`, `detectBeats`, `calibrateScreen`; the AI-suggestion
review keys are `inkling.core`'s. The `measurements` panel (slot right) shows rates, wave
intervals, track episodes and record statements.

An accelerometer CSV with event labels on a plain grid:

```json
{
  "data": { "kind": "inkling.timeseries.dataKinds.multichannel-timeseries" },
  "viewports": [{
    "name": "main",
    "renderer": "inkling.timeseries.renderers.strip-chart",
    "config": {
      "reader": "csv", "grid": "plain", "unit": "g", "gain": 20,
      "track": { "channel": "activity", "label": "Activity" },
      "trackCodes": [{ "id": "walk" }, { "id": "run" }, { "id": "rest" }],
      "instantCodes": [{ "id": "step", "hotkey": "shift+s" }, { "id": "fall", "hotkey": "shift+f" }]
    }
  }],
  "tools": ["inkling.core.tools.select", "inkling.core.tools.pan", "inkling.timeseries.tools.interval",
            "inkling.timeseries.tools.beat", "inkling.timeseries.tools.rhythm", "inkling.timeseries.tools.caliper"],
  "labels": [{ "name": "events", "control": "TimeSeriesLabels", "classes": [{ "id": "event" }, { "id": "artifact" }] }],
  "keybindings": [{ "command": "inkling.timeseries.commands.setBeatCode", "keys": ["shift+s", "shift+f"] }],
  "panels": { "left": ["inkling.core.panels.files", "inkling.core.panels.labels"], "right": ["inkling.timeseries.panels.measurements"] },
  "exporters": ["inkling.timeseries.exporters.ecg-intervals-csv", "inkling.timeseries.exporters.ecg-json"]
}
```
