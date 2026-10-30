# inkling.cardiac-metrics — ventricular function on a cine

Requires `inkling.cine`. A right-slot `metrics` panel (EDV, ESV, SV and EF for LV and RV
by Simpson's method of discs, LV mass at 1.05 g/mL, indexed by Mosteller BSA, the volume
curve with an ED / ES suggestion, per-slice areas of the current frame, Dice against
reference segmentations) and a `function-csv` exporter. It reads the cine renderer's
`structures` config and what the renderer publishes to the runtime (`grid`, `playhead`,
`cine.coverage`, `cine.references`), so it can be included or left out per environment.
`phases` config names the cine key frames that are ED and ES.

```json
{
  "extends": "preset:cine-4d",
  "panels": { "right": ["inkling.cardiac-metrics.panels.metrics", "inkling.core.panels.ai"] },
  "exporters": ["inkling.cine.exporters.acdc-nifti", "inkling.cardiac-metrics.exporters.function-csv"]
}
```
