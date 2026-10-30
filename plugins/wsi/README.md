# inkling.wsi: tiled image pyramids

Deep-zoom image pyramids (DZI; whole-slide pathology, but any tiled pyramid such as
satellite imagery) on OpenSeadragon. Vector editing is renderers/overlay2d's `OverlayEngine`
(select / move / reshape, box, ellipse, polygon, freehand, polyline, length, points,
brush and eraser on vector regions); this module adds the OSD transform, the navigator,
colour adjustments and the magic wand (`inkling.wsi.tools.wand`, which reads tile pixels).

- Renderer `inkling.wsi.renderers.osd` (`space: image2d`), config `{ objective?, mpp?, showNavigator }`.
  It publishes `mpp` to the runtime; the inspector (`inspectors.main`) and the counts panel read it.
- Panels: `panels.counts` (right: points per class, inside the selected region, density per mm²)
  and `panels.adjust` (viewport-bar: brightness / contrast / gamma / saturation). The adjust
  panel writes the runtime key `adjust` for the item; the renderer applies it to the tiles.
- Commands: `commands.toggleClassNames` (N), `commands.importGeoJSON` (QuPath / Cytomine GeoJSON
  as one undo step; also the upload button in the viewer bar). Drawing keys (Enter, Esc,
  Backspace, Space, Shift+R) are core commands enabled by the renderer's capabilities.
- Points are core `keypoint`s (v1 `mark` migrates on load). Exporters: QuPath GeoJSON,
  ASAP XML, cell counts CSV.

```json
{
  "data": { "kind": "inkling.wsi.dataKinds.raster-pyramid" },
  "viewports": [{ "name": "main", "renderer": "inkling.wsi.renderers.osd", "config": { "mpp": 0.25 } }],
  "tools": ["inkling.core.tools.select", "inkling.core.tools.pan", "inkling.overlay2d.tools.polygon", "inkling.wsi.tools.brush", "inkling.wsi.tools.wand", "inkling.wsi.tools.mark"],
  "panels": { "left": ["inkling.core.panels.files", "inkling.core.panels.labels"], "right": ["inkling.wsi.panels.counts"], "viewport-bar": ["inkling.wsi.panels.adjust"] },
  "exporters": ["inkling.wsi.exporters.qupath-geojson", "inkling.wsi.exporters.point-counts-csv"],
  "labels": [{ "name": "tissue", "control": "PolygonLabels", "classes": [{ "id": "tumor" }, { "id": "stroma" }] }]
}
```
