# 2D images (`inkling.image2d`)

Single-frame images as one item per file (`dataKinds.raster`: PNG, JPEG, WebP, single-frame
DICOM), with two renderers:

- `renderers.cornerstone-stack`: a Cornerstone3D StackViewport for radiology
  (`renderer/CornerstoneStackEngine.ts` + `renderer/Host.tsx`). It works with the
  `inkling.cornerstone` tools (ROIs, measurements, brush / eraser / wand). Its view controls
  (window/level presets, invert, flip, rotate, fit, color map, interpolation, magnifier)
  live in the `panels.viewControls` viewport-bar panel, and you can switch each one off in
  the renderer config (`windowLevel: false` for natural photos). The keys come from
  commands: `inkling.cornerstone.commands.*`, `inkling.core.commands.rotateView` /
  `holdToPan`, `commands.fitView` (`0`, `=`) and `commands.cancelManipulation` (Escape).
- `renderers.canvas-raster`: a plain `<canvas>` with no Cornerstone, for natural images
  (`renderer/canvas/`). It supports pan, wheel zoom, select / move / resize via the overlay2d
  ShapeUtils, and the `inkling.overlay2d` `box`, `polygon` and `keypoint` tools, which
  create core geometries. Delete, undo and Escape / Enter / Backspace while drawing go
  through core commands. `preset:generic-image` uses it by default.

The renderer publishes `image2d.view` (state) and `image2d.controls` (actions) in the
item runtime for the panel (`view.ts`). The canvas renderer publishes `viewportState`.
`exporters.coco` writes COCO JSON.

```json
{
  "extends": "preset:generic-image",
  "labels": [{ "name": "products", "control": "RectangleLabels", "classes": [{ "id": "cereal" }, { "id": "soda" }] }]
}
```

```json
{
  "extends": "preset:image-2d",
  "viewports": [{ "name": "main", "renderer": "inkling.image2d.renderers.cornerstone-stack", "config": { "windowLevel": false, "colormap": false } }],
  "overrides": [{ "id": "inkling.cornerstone.tools.cobb", "disabled": true }]
}
```
