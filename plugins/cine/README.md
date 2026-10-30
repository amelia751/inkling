# inkling.cine — slice × frame series

Any 4D image series (slices × frames, e.g. a 4D NIfTI cine MRI, a time-lapse z-stack) as
one study item (`volume-time`). The `slice-frame-canvas` renderer draws one slice and frame
at a time with spline / polygon / freehand contours and brush masks, a slice × frame
thumbnail matrix, playback (`renderers/viewport-chrome` Transport), copy-forward
(Alt / Shift+Alt + arrows), shape interpolation across frames or slices (optionally
cyclic) and import of reference label volumes as editable splines.

Domain vocabulary is renderer config, not code: `structures` maps the roles `rv` / `myo` /
`lv` to label ids (label-map paint order, areas, completeness, and the enclosure rule: a
`myo` contour around an `lv` contour is its outer border) and `keyFrames` names the frames
an expert can mark (stored as core `instant { frame }` with `attributes: { kind: "phase",
phase }`). `preset:cine-4d` sets both for ACDC cardiac labels; add
`inkling.cardiac-metrics` for EF, volumes and mass.

Runtime (per item): `grid` (`{ nx, ny, nz, frames, spacing, dims }`), `playhead`
(`{ frame, time, slice }`), `cine.references`, `cine.coverage`. Command
`inkling.cine.commands.goTo` (`{ slice?, frame? }`) navigates.

```json
{
  "data": { "kind": "inkling.cine.dataKinds.volume-time" },
  "viewports": [{
    "name": "main",
    "renderer": "inkling.cine.renderers.slice-frame-canvas",
    "config": { "structures": {}, "keyFrames": [{ "id": "peak", "label": "Peak uptake" }] }
  }],
  "tools": ["inkling.core.tools.select", "inkling.core.tools.pan", "inkling.overlay2d.tools.spline", "inkling.overlay2d.tools.brush"],
  "exporters": ["inkling.cine.exporters.acdc-nifti", "inkling.cine.exporters.cine-contours-json"],
  "labels": [{ "name": "regions", "control": "Labels", "classes": [{ "id": "lesion" }] }]
}
```
