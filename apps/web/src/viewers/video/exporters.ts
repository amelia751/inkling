import { labelNames } from "@/platform/environment";
import type { Annotation, Project, Pt, StudioItem } from "@/types";
import type { Exporter } from "@/viewers/ViewerAdapter";
import { keyframeAt, shapeAt, sortKeyframes, trackNumbers, type Box, type TrackGeometry } from "./tracks";
import { zip } from "@/kits/io/zip";

/** Frame count and rate of a video item, from the seed metadata. */
export function videoTiming(item: StudioItem): { fps: number; frames: number; duration: number } {
  const a = item.assets[0];
  const fps = a?.fps ?? 25;
  const frames = a?.frames ?? Math.round((a?.duration ?? 0) * fps);
  return { fps, frames, duration: a?.duration ?? frames / fps };
}

const fileName = (item: StudioItem) => item.assets[0]?.path.split("/").pop() ?? item.name;
const stem = (item: StudioItem) => fileName(item).replace(/\.[^.]+$/, "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

interface Row {
  frame: number;
  keyframe: boolean;
  outside: boolean;
  occluded: boolean;
  box?: Box;
  points?: Pt[];
}

/**
 * Every frame of a track, as CVAT dumps it: one row per visible frame (interpolated rows
 * have keyframe="0"), an outside="1" row on each outside keyframe, nothing in the gaps.
 */
export function trackRows(g: TrackGeometry, total: number): Row[] {
  const kfs = sortKeyframes(g.keyframes);
  if (!kfs.length) return [];
  const rows: Row[] = [];
  let last: Pick<Row, "box" | "points"> | null = null;
  for (let f = kfs[0].frame; f < total; f++) {
    const kf = keyframeAt(g, f);
    const s = shapeAt(g, f);
    if (s) {
      last = { box: s.box, points: s.points };
      rows.push({ frame: f, keyframe: !!kf, outside: false, occluded: s.occluded, box: s.box, points: s.points });
    } else if (kf?.outside) {
      const shape = kf.box || kf.points ? { box: kf.box, points: kf.points } : last;
      if (shape) rows.push({ frame: f, keyframe: true, outside: true, occluded: !!kf.occluded, ...shape });
    }
  }
  return rows;
}

/** Per-frame shapes become one-frame tracks (keyframe + outside on the next frame), as CVAT converts them. */
function shapeRows(a: Annotation, total: number): { kind: "box" | "polygon" | "keypoint"; rows: Row[] } | null {
  const g = a.geometry;
  let kind: "box" | "polygon" | "keypoint";
  let shape: Pick<Row, "box" | "points">;
  if (g.type === "box") (kind = "box"), (shape = { box: [g.x, g.y, g.w, g.h] });
  else if (g.type === "polygon") (kind = "polygon"), (shape = { points: g.points });
  else if (g.type === "keypoint") (kind = "keypoint"), (shape = { points: [[g.x, g.y]] });
  else return null;
  const f = "frame" in g && g.frame !== undefined ? g.frame : 0;
  const rows: Row[] = [{ frame: f, keyframe: true, outside: false, occluded: false, ...shape }];
  if (f + 1 < total) rows.push({ frame: f + 1, keyframe: true, outside: true, occluded: false, ...shape });
  return { kind, rows };
}

const source = (a: Annotation) => (a.provenance === "ai-suggested" ? "auto" : a.provenance === "human-corrected" ? "semi-auto" : "manual");

function cvatXml(project: Project, item: StudioItem, annotations: Annotation[], taskId: number): string {
  const { frames } = videoTiming(item);
  const asset = item.assets[0];
  const labels = labelNames(project.labels);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>', "<annotations>", "  <version>1.1</version>", "  <meta>", "    <task>");
  out.push(`      <id>${taskId}</id>`, `      <name>${esc(`${project.title} · ${fileName(item)}`)}</name>`, `      <size>${frames}</size>`);
  out.push("      <mode>interpolation</mode>", "      <overlap>0</overlap>", "      <bugtracker></bugtracker>");
  out.push(`      <start_frame>0</start_frame>`, `      <stop_frame>${Math.max(0, frames - 1)}</stop_frame>`, "      <frame_filter></frame_filter>", "      <labels>");
  for (const l of labels) out.push(`        <label><name>${esc(l)}</name><type>any</type><attributes></attributes></label>`);
  out.push("      </labels>");
  out.push(`      <original_size><width>${asset?.width ?? 0}</width><height>${asset?.height ?? 0}</height></original_size>`);
  out.push("    </task>", `    <dumped>${new Date().toISOString()}</dumped>`, `    <source>${esc(fileName(item))}</source>`, "  </meta>");

  const mine = annotations.filter((a) => a.itemId === item.id);
  let id = 0;
  const writeTrack = (a: Annotation, kind: "box" | "polygon" | "keypoint", rows: Row[]) => {
    if (!rows.length) return;
    out.push(`  <track id="${id++}" label="${esc(a.label)}" source="${source(a)}">`);
    for (const r of rows) {
      const common = `frame="${r.frame}" keyframe="${+r.keyframe}" outside="${+r.outside}" occluded="${+r.occluded}"`;
      if (kind === "box" && r.box) {
        const [x, y, w, h] = r.box;
        out.push(`    <box ${common} xtl="${n2(x)}" ytl="${n2(y)}" xbr="${n2(x + w)}" ybr="${n2(y + h)}" z_order="0"></box>`);
      } else if (r.points) {
        const pts = r.points.map(([x, y]) => `${n2(x)},${n2(y)}`).join(";");
        out.push(`    <${kind === "polygon" ? "polygon" : "points"} ${common} points="${pts}" z_order="0"></${kind === "polygon" ? "polygon" : "points"}>`);
      }
    }
    out.push("  </track>");
  };
  for (const a of mine) {
    if (a.geometry.type === "track") writeTrack(a, a.geometry.shape, trackRows(a.geometry, frames));
    else {
      const s = shapeRows(a, frames);
      if (s) writeTrack(a, s.kind, s.rows);
    }
  }
  out.push("</annotations>", "");
  return out.join("\n");
}

function motCsv(project: Project, item: StudioItem, annotations: Annotation[]): string {
  const { frames } = videoTiming(item);
  const labels = labelNames(project.labels);
  const mine = annotations.filter((a) => a.itemId === item.id);
  const numbers = trackNumbers(mine);
  let nextId = Math.max(0, ...numbers.values()) + 1;
  const lines: { frame: number; id: number; line: string }[] = [];
  const cls = (label: string) => labels.indexOf(label) + 1;
  const push = (frame: number, id: number, b: Box, label: string, occluded: boolean) =>
    lines.push({ frame, id, line: [frame + 1, id, n2(b[0]), n2(b[1]), n2(b[2]), n2(b[3]), 1, cls(label), occluded ? 0.5 : 1].join(",") });
  for (const a of mine) {
    const g = a.geometry;
    if (g.type === "track" && g.shape === "box") {
      const id = numbers.get(a.id)!;
      for (const r of trackRows(g, frames)) if (!r.outside && r.box) push(r.frame, id, r.box, a.label, r.occluded);
    } else if (g.type === "box") {
      push(g.frame ?? 0, nextId++, [g.x, g.y, g.w, g.h], a.label, false);
    }
  }
  return lines.sort((x, y) => x.frame - y.frame || x.id - y.id).map((l) => l.line).join("\n") + "\n";
}

function seqinfo(item: StudioItem): string {
  const { fps, frames } = videoTiming(item);
  const a = item.assets[0];
  return `[Sequence]\nname=${stem(item)}\nimDir=img1\nframeRate=${fps}\nseqLength=${frames}\nimWidth=${a?.width ?? 0}\nimHeight=${a?.height ?? 0}\nimExt=.jpg\n`;
}

function temporalJson(project: Project, items: StudioItem[], annotations: Annotation[]): string {
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return JSON.stringify(
    {
      format: "inkling-video-temporal",
      version: 1,
      project: { id: project.id, title: project.title, labels: labelNames(project.labels) },
      exportedAt: new Date().toISOString(),
      note: "Frames are 0-based; frame f spans [f/fps, (f+1)/fps) seconds. Segment endFrame is inclusive.",
      videos: items.map((item) => {
        const { fps, frames, duration } = videoTiming(item);
        const mine = annotations.filter((a) => a.itemId === item.id);
        return {
          item: item.id,
          file: fileName(item),
          fps,
          frames,
          duration,
          segments: mine.flatMap((a) =>
            a.geometry.type === "segment"
              ? [{
                  id: a.id,
                  label: a.label,
                  start: r3(a.geometry.start),
                  end: r3(a.geometry.end),
                  duration: r3(a.geometry.end - a.geometry.start),
                  startFrame: Math.round(a.geometry.start * fps),
                  endFrame: Math.max(Math.round(a.geometry.start * fps), Math.round(a.geometry.end * fps) - 1),
                  provenance: a.provenance,
                  attributes: a.attributes ?? {},
                }]
              : [],
          ).sort((x, y) => x.start - y.start),
          events: mine.flatMap((a) =>
            a.geometry.type === "event"
              ? [{ id: a.id, label: a.label, frame: a.geometry.frame, time: r3(a.geometry.frame / fps), provenance: a.provenance, attributes: a.attributes ?? {} }]
              : [],
          ).sort((x, y) => x.frame - y.frame),
        };
      }),
    },
    null,
    2,
  );
}

export const videoExporters: Exporter[] = [
  {
    id: "cvat-video",
    label: "CVAT for video 1.1",
    description: "One annotations XML per video: tracks with every frame interpolated (keyframe, outside, occluded flags); per-frame shapes as one-frame tracks.",
    filename: (p) => `${p.id}-cvat-video.zip`,
    build: async ({ project, items, annotations }) =>
      zip(items.map((item, i) => ({ name: `${stem(item)}/annotations.xml`, text: cvatXml(project, item, annotations, i + 1) }))),
  },
  {
    id: "mot",
    label: "MOT challenge CSV",
    description: "Box tracks per video as gt/gt.txt (frame, id, x, y, w, h, conf, class, visibility; 1-based frames) with seqinfo.ini.",
    filename: (p) => `${p.id}-mot.zip`,
    build: async ({ project, items, annotations }) =>
      zip(items.flatMap((item) => [
        { name: `${stem(item)}/gt/gt.txt`, text: motCsv(project, item, annotations) },
        { name: `${stem(item)}/seqinfo.ini`, text: seqinfo(item) },
      ])),
  },
  {
    id: "temporal-json",
    label: "Temporal JSON",
    description: "Labeled segments and point-in-time events per video, in seconds and frames.",
    filename: (p) => `${p.id}-temporal.json`,
    build: async ({ project, items, annotations }) => new Blob([temporalJson(project, items, annotations)], { type: "application/json" }),
  },
];
