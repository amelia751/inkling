import { VideoIcon } from "@studio/ui/icons";
import { defineModule } from "@studio/plugin-ui-sdk/module";
import type { Project, StudioItem } from "@studio/contracts/types";
import { videoGeometries } from "./geometries";
import { NS, ns } from "@studio/contracts/naming";
import { assetName } from "@studio/plugin-ui-sdk/assets";

export const VIDEO = ns("video");
const core = (n: string) => `${NS}.core.commands.${n}`;

function groupItems(project: Project): StudioItem[] {
  return project.assets.map((a) => ({
    id: a.path,
    name: assetName(a),
    group: a.label ? a.label[0].toUpperCase() + a.label.slice(1) : "Videos",
    assets: [a],
    sourceLabel: a.label,
    dataKind: `${VIDEO}.dataKinds.video`,
  }));
}

export default defineModule({
  id: VIDEO,
  version: "1.0.0",
  title: "Video",
  description: "Frame-accurate video (mp4 / webm) with tracks interpolated between keyframes, per-frame shapes, segments and events on a timeline.",
  requires: [ns("overlay2d"), ns("timeline")],
  contributes: {
    dataKinds: [
      { id: "video", label: "Video", icon: VideoIcon, itemNoun: "video", match: { ext: [".mp4", ".webm", ".zip", ".avi", ".mov", ".mkv"] }, fileKinds: ["video"], groupItems, description: "One item per video file (or frame archive)" },
    ],
    renderers: [
      {
        id: "frame-canvas",
        consumes: [`${VIDEO}.dataKinds.video`],
        space: "image2d",
        capabilities: ["time", "playback", "drafting", "vertexUndo", "holdToPan", "tracks"],
        description: "WebCodecs frame canvas with a playback clock, A–B range, filmstrip timeline and track overlays",
      },
    ],
    commands: [
      { id: "stepFrame", keys: ["ArrowLeft", "ArrowRight"], display: "← →", label: "Previous or next frame", group: "Playback", repeat: true, shadows: [core("prevItem"), core("nextItem")], description: "Step one frame" },
      { id: "step10", keys: ["shift+ArrowLeft", "shift+ArrowRight", "shift+,", "shift+."], display: "⇧ ← →", label: "Back or forward 10 frames", group: "Playback", repeat: true, description: "Step ten frames" },
      { id: "firstLastFrame", keys: ["Home", "End"], display: "Home / End", label: "First or last frame (of the A–B range if set)", group: "Playback", description: "Jump to the first or last frame" },
      { id: "toggleLoop", keys: ["l"], label: "Loop playback", group: "Playback", description: "Toggle looping" },
      { id: "fitView", keys: ["f"], label: "Fit video to view", group: "View", description: "Fit the frame to the viewport" },
      { id: "toggleKeyframe", keys: ["shift+k"], label: "Add or remove a keyframe on the selected tracks", group: "Drawing", description: "Toggle a keyframe at the playhead" },
      { id: "toggleOutside", keys: ["o"], label: "Mark selected tracks outside / back in view", group: "Drawing", description: "Toggle outside at the playhead" },
      { id: "toggleOccluded", keys: ["shift+o"], label: "Toggle occluded on the selected tracks", group: "Drawing", description: "Toggle occluded at the playhead" },
      { id: "prevKeyframe", keys: ["alt+,"], label: "Previous keyframe", group: "Navigate", description: "Jump to the previous keyframe" },
      { id: "nextKeyframe", keys: ["alt+."], label: "Next keyframe", group: "Navigate", description: "Jump to the next keyframe" },
      { id: "copyToNextFrame", keys: ["alt+b"], label: "Copy selected shapes to the next frame", group: "Drawing", description: "Propagate the selection one frame" },
      { id: "addEvent", keys: ["Enter"], label: "Mark an event at the current frame", group: "Drawing", contextual: true, when: "tool == event", description: "Add an event at the playhead" },
    ],
    geometries: videoGeometries,
    inspectors: [{ id: "main", geometries: "*", description: "Frames, times and sizes; a track's shape at the playhead" }],
    exporters: [
      { id: "cvat-video", label: "CVAT for video 1.1", accepts: ["track", "box", "polygon", "keypoint"], description: "One annotations XML per video: tracks with every frame interpolated (keyframe, outside, occluded flags); per-frame shapes as one-frame tracks." },
      { id: "mot", label: "MOT challenge CSV", accepts: ["track", "box"], description: "Box tracks per video as gt/gt.txt (frame, id, x, y, w, h, conf, class, visibility; 1-based frames) with seqinfo.ini." },
      { id: "temporal-json", label: "Temporal JSON", accepts: ["span", "instant"], description: "Labeled segments and point-in-time events per video, in seconds and frames." },
    ],
  },
  load: () => import("./impl"),
});
