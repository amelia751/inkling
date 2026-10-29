# Example module (template)

One data kind (`file`), a canvas renderer, a `dot` tool that creates core `keypoint`
geometries, and a `count` panel in the right slot. Copy the folder, rename the id, register
it in `src/bundle.ts`, and boot it with:

```json
{
  "data": { "kind": "inkling.example.dataKinds.file" },
  "viewports": [{ "name": "main", "renderer": "inkling.example.renderers.canvas" }],
  "tools": ["inkling.core.tools.select", "inkling.example.tools.dot"],
  "panels": { "left": ["inkling.core.panels.files", "inkling.core.panels.labels"], "right": ["inkling.example.panels.count"] },
  "labels": [{ "name": "points", "control": "KeyPointLabels", "classes": [{ "id": "dot" }] }]
}
```
