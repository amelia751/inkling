# Video (`inkling.video`)

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
  "data": { "kind": "inkling.video.dataKinds.video" },
  "viewports": [{ "name": "main", "renderer": "inkling.video.renderers.frame-canvas" }],
  "tools": [
    "inkling.core.tools.select", "inkling.core.tools.pan",
    "inkling.overlay2d.tools.box", "inkling.overlay2d.tools.polygon", "inkling.overlay2d.tools.keypoint",
    "inkling.timeline.tools.segment", "inkling.timeline.tools.event"
  ],
  "labels": [{ "name": "objects", "control": "VideoRectangle", "classes": [{ "id": "car" }, { "id": "person" }] }],
  "exporters": ["inkling.video.exporters.cvat-video", "inkling.video.exporters.mot", "inkling.video.exporters.temporal-json"]
}
```
