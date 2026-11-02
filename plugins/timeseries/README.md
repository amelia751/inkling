# Multichannel time series (`studio.timeseries`)

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
review keys are `studio.core`'s. The `measurements` panel (slot right) shows rates, wave
intervals, track episodes and record statements.

An accelerometer CSV with event labels on a plain grid:

```json
{
  "data": { "kind": "studio.timeseries.dataKinds.multichannel-timeseries" },
  "viewports": [{
    "name": "main",
    "renderer": "studio.timeseries.renderers.strip-chart",
    "config": {
      "reader": "csv", "grid": "plain", "unit": "g", "gain": 20,
      "track": { "channel": "activity", "label": "Activity" },
      "trackCodes": [{ "id": "walk" }, { "id": "run" }, { "id": "rest" }],
      "instantCodes": [{ "id": "step", "hotkey": "shift+s" }, { "id": "fall", "hotkey": "shift+f" }]
    }
  }],
  "tools": ["studio.core.tools.select", "studio.core.tools.pan", "studio.timeseries.tools.interval",
            "studio.timeseries.tools.beat", "studio.timeseries.tools.rhythm", "studio.timeseries.tools.caliper"],
  "labels": [{ "name": "events", "control": "TimeSeriesLabels", "classes": [{ "id": "event" }, { "id": "artifact" }] }],
  "keybindings": [{ "command": "studio.timeseries.commands.setBeatCode", "keys": ["shift+s", "shift+f"] }],
  "panels": { "left": ["studio.core.panels.files", "studio.core.panels.labels"], "right": ["studio.timeseries.panels.measurements"] },
  "exporters": ["studio.timeseries.exporters.ecg-intervals-csv", "studio.timeseries.exporters.ecg-json"]
}
```
