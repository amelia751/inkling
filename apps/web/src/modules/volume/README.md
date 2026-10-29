# Volume module (`inkling.volume`)

3D volumes (NIfTI sequences, DICOM series) on Cornerstone3D. The `volume` data kind groups
a project's assets by subject; `volumeSources()` splits a subject into the volumes the
renderer can show (one per NIfTI `sequence`, one per DICOM series), which drives the
sequence picker, and `sequence: "seg"` is the read-only reference segmentation. The
`cornerstone-mpr` renderer shows linked orthographic planes with crosshairs and VOI sync,
optionally a 3D render, edits 3D labelmaps (brush, eraser, wand / smart fill) stored as
RLE `mask`s, and Cornerstone measurements stored in world mm. Landmarks are core `point3d`
(voxel `ijk` plus the plane and slice). Exporters: NIfTI labelmap (current subject) and
masks JSON (all subjects).

Layout: `renderer/MprEngine.ts` (imperative engine: session per subject, view per layout /
sequence, view actions, labelmap commands), `renderer/Host.tsx` (React host: UI state,
`useCommands`, cells and overlays), `renderer/ViewBar.tsx` (the viewport bar). Keys are
commands: `inkling.volume.commands.{stepSlice, firstLastSlice, fitView, cancelManipulation,
interpolateSlices, removeIslands, smartFill, similarFill}`, plus
`inkling.cornerstone.commands.*` (invert, flips, rotate left, magnifier) and
`inkling.core.commands.{rotateView, holdToPan}`. The renderer publishes `volume`
(`{ dims, spacing, modality, frameOfReferenceUID }`) and `viewportState`
(`{ layout, sequence, activePlane, slices }`) to the runtime.

Renderer config: `layout` (`mpr` 1×3, `main` 1 + 2, `single`, `mpr3d` 2×2 with 3D,
`plane3d` 1 + 3D; default `mpr`), `layouts` (what the Layout picker offers), `plane`
(for `single` / `plane3d`), `sequence` (opened first when present, default `flair`) and
`preset3d` (volume-rendering preset of the 3D cell).

```json
{
  "extends": "preset:volume-3d",
  "viewports": [{ "name": "main", "renderer": "inkling.volume.renderers.cornerstone-mpr",
                  "config": { "layout": "plane3d", "layouts": ["mpr", "mpr3d", "plane3d"], "sequence": "t1ce" } }],
  "labels": [{ "name": "tumour", "control": "BrushLabels", "classes": [{ "id": "edema", "color": "#e6c84f" }] }]
}
```
