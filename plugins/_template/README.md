# Example module (template)

One data kind (`file`), a canvas renderer, a `dot` tool that creates core `keypoint`
geometries, and a `count` panel in the right slot. Copy the folder, rename the id, register
it in `apps/web/src/extension-host/bundled.ts`, and boot it with:

```json
{
  "data": { "kind": "studio.example.dataKinds.file" },
  "viewports": [{ "name": "main", "renderer": "studio.example.renderers.canvas" }],
  "tools": ["studio.core.tools.select", "studio.example.tools.dot"],
  "panels": { "left": ["studio.core.panels.files", "studio.core.panels.labels"], "right": ["studio.example.panels.count"] },
  "labels": [{ "name": "points", "control": "KeyPointLabels", "classes": [{ "id": "dot" }] }]
}
```
