# Video (`studio.video`)

Frame-accurate video annotation. The `frame-canvas` renderer decodes every frame exactly with
WebCodecs (falling back to `<video>` seeking), plays through a requestVideoFrameCallback clock
with an A–B loop range, and edits shapes per frame through `renderers/overlay2d` ShapeUtils. Shapes
drawn in Track mode become core `track` geometries (CVAT keyframe / outside / occluded
semantics, interpolated between keyframes; `trackShape.ts` is the ShapeUtil that resolves a track
at the playhead); Per-frame mode stores `box` / `polygon` / `keypoint` with `frame`. Segments and
events are core `span` / `instant` on the `renderers/timeline` lanes. The renderer publishes
`runtime.playhead` (`{ frame, time }`) for the inspector. Exports: CVAT for video 1.1, MOT CSV and
temporal JSON.

Layout: `renderer/VideoEngine.ts` (frame source, playback clock), `renderer/Host.tsx` (React
host), `renderer/FrameEditor.ts` (per-frame 2D editing), `renderer/VideoTimeline.tsx` (lanes),
`renderer/TransportBar.tsx` and `renderer/StageBars.tsx` (chrome), `renderer/useVideoCommands.ts`
(command handlers), `tracks.ts` (interpolation), `geometries.ts`, `inspect.ts`, `exporters.ts`.

```json
{
  "data": { "kind": "studio.video.dataKinds.video" },
  "viewports": [{ "name": "main", "renderer": "studio.video.renderers.frame-canvas" }],
  "tools": [
    "studio.core.tools.select", "studio.core.tools.pan",
    "studio.overlay2d.tools.box", "studio.overlay2d.tools.polygon", "studio.overlay2d.tools.keypoint",
    "studio.timeline.tools.segment", "studio.timeline.tools.event"
  ],
  "labels": [{ "name": "objects", "control": "VideoRectangle", "classes": [{ "id": "car" }, { "id": "person" }] }],
  "exporters": ["studio.video.exporters.cvat-video", "studio.video.exporters.mot", "studio.video.exporters.temporal-json"]
}
```
