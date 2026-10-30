import type { InspectFn } from "@studio/plugin-ui-sdk/module";
import { polygonArea } from "@studio/renderers/overlay2d/geometry";
import { formatTime } from "@studio/renderers/viewport-chrome/format";
import { videoTiming } from "./exporters";
import { shapeAt, sortKeyframes, trackSpans, visibleFrameCount } from "./tracks";

/** Runtime value the video renderer publishes for its item (`runtime.playhead`). */
export interface Playhead {
  frame: number;
  time: number;
}

const px = (v: number) => `${Math.round(v)} px`;

/** Inspector rows: frames, times and sizes; a track's shape at the playhead. */
export const inspectVideo: InspectFn = (a, { item, runtime }) => {
  const { fps, frames } = videoTiming(item);
  const g = a.geometry;
  const fr = (f: number) => `${f + 1}`;
  const secs = (n: number) => `${(n / fps).toFixed(2)} s`;
  switch (g.type) {
    case "track": {
      const kfs = sortKeyframes(g.keyframes);
      const spans = trackSpans(g, frames);
      const visible = visibleFrameCount(g, frames);
      const occluded = spans.filter((s) => s.occluded).reduce((n, s) => n + s.end - s.start, 0);
      const rows: [string, string][] = [
        ["Track", `#${a.attributes?.trackId ?? "–"} · ${g.shape}`],
        ["Keyframes", `${kfs.length}`],
        ["Frames", spans.length ? `${fr(spans[0].start)}–${fr(spans[spans.length - 1].end - 1)}` : "outside"],
        ["Visible", `${visible} frames · ${secs(visible)}`],
      ];
      if (occluded) rows.push(["Occluded", `${occluded} frames`]);
      const cur = runtime.get<Playhead>("playhead")?.frame;
      if (cur !== undefined) {
        const s = shapeAt(g, cur);
        const label = `At frame ${fr(cur)}`;
        if (!s) rows.push([label, "outside"]);
        else if (s.box) rows.push([label, `${px(s.box[2])} × ${px(s.box[3])}${s.keyframe ? " · keyframe" : ""}`]);
        else if (g.shape === "polygon") rows.push([label, `${s.points!.length} vertices · ${Math.round(polygonArea(s.points!))} px²`]);
        else rows.push([label, s.points!.map(([x, y]) => `(${Math.round(x)}, ${Math.round(y)})`).join(" ")]);
      }
      return rows;
    }
    case "box":
      return [["Frame", g.frame !== undefined ? fr(g.frame) : "all"], ["Size", `${px(g.w)} × ${px(g.h)}`], ["Origin", `${px(g.x)}, ${px(g.y)}`]];
    case "polygon":
      return [["Frame", g.frame !== undefined ? fr(g.frame) : "all"], ["Vertices", `${g.points.length}`], ["Area", `${Math.round(polygonArea(g.points))} px²`]];
    case "keypoint":
      return [["Frame", g.frame !== undefined ? fr(g.frame) : "all"], ["Position", `${px(g.x)}, ${px(g.y)}`]];
    case "span": {
      const f0 = Math.round(g.start * fps), f1 = Math.max(f0, Math.round(g.end * fps) - 1);
      return [
        ["Start", `${formatTime(g.start)} · frame ${fr(f0)}`],
        ["End", `${formatTime(g.end)} · frame ${fr(f1)}`],
        ["Duration", `${(g.end - g.start).toFixed(2)} s · ${f1 - f0 + 1} frames`],
      ];
    }
    case "instant": {
      const f = g.frame ?? Math.round((g.t ?? 0) * fps);
      return [["Frame", fr(f)], ["Time", formatTime(f / fps)]];
    }
    default:
      return [];
  }
};
