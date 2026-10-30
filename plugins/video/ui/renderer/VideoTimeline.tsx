import { useMemo } from "react";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { formatTime } from "@studio/renderers/viewport-chrome/format";
import { Timeline, type FilmstripSource, type TimelineLane } from "@studio/renderers/timeline/Timeline";
import type { Annotation, Geometry } from "@studio/contracts/types";
import { moveKeyframe, sortKeyframes, trackSpans } from "../tracks";
import { addInstant, addSpan, editable, setGeometry } from "./actions";
import { useHost } from "@studio/plugin-ui-sdk";

type Of<T extends Geometry["type"]> = Annotation & { geometry: Extract<Geometry, { type: T }> };
const instantFrame = (g: Extract<Geometry, { type: "instant" }>, fps: number) => g.frame ?? Math.round((g.t ?? 0) * fps);

/**
 * The video's lanes on the kits/timeline axis: an events lane (instants), one span lane per
 * label, per-frame shapes, and one lane per object track (visible spans, keyframe diamonds,
 * hatched occlusion).
 */
export function VideoTimeline(p: {
  itemId: string;
  frames: number;
  fps: number;
  frame: number;
  labels: string[];
  visible: Annotation[];
  numbers: Map<string, number>;
  range: { a: number; b: number } | null;
  filmstrip: FilmstripSource | null;
  onSeek: (f: number) => void;
  onRange: (r: { a: number; b: number } | null) => void;
}) {
  const { itemId, frames, fps, labels, visible, numbers } = p;
  const tool = useHost((s) => s.tool);
  const activeLabel = useHost((s) => s.activeLabel);
  const selectedIds = useHost((s) => s.selectedIds);
  const lockedLabels = useHost((s) => s.lockedLabels);

  const lanes = useMemo<TimelineLane[]>(() => {
    const selected = new Set(selectedIds);
    const tint = (label: string) => (alpha = 1) => labelColor(labels, label, alpha);
    const swatch = (label: string) => <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: labelColor(labels, label) }} />;
    const of = <T extends Geometry["type"]>(t: T) => visible.filter((a): a is Of<T> => a.geometry.type === t);
    const out: TimelineLane[] = [];

    out.push({
      id: "events",
      header: <span>Events</span>,
      create: tool === "event" && activeLabel ? "instant" : undefined,
      cursor: tool === "event" ? "cursor-copy" : "cursor-pointer",
      items: of("instant").map((a) => {
        const f = instantFrame(a.geometry, fps);
        return { kind: "instant", key: a.id, select: a.id, frame: f, marker: "flag", tint: tint(a.label), selected: selected.has(a.id), draggable: editable(a), attrs: { "data-event": a.id }, title: `${a.label} · frame ${f + 1} · ${formatTime(f / fps)}`, meta: a };
      }),
    });

    const spans = of("span");
    for (const label of labels)
      out.push({
        id: `seg-${label}`,
        header: <>{swatch(label)}<span className="truncate capitalize">{label}</span></>,
        create: tool === "segment" ? "span" : undefined,
        cursor: tool === "segment" ? "cursor-crosshair" : "cursor-pointer",
        items: spans
          .filter((a) => a.label === label)
          .map(({ geometry: g, ...a }) => ({
            kind: "span",
            key: a.id,
            select: a.id,
            start: g.start,
            end: g.end,
            tint: tint(a.label),
            selected: selected.has(a.id),
            editable: editable({ ...a, geometry: g }),
            attrs: { "data-seg": a.id },
            title: `${a.label} · ${formatTime(g.start)}–${formatTime(g.end)} (${(g.end - g.start).toFixed(2)} s)`,
            meta: { ...a, geometry: g },
          })),
      });

    // Per-frame shapes
    const shapes = visible.filter((a) => (a.geometry.type === "box" || a.geometry.type === "polygon" || a.geometry.type === "keypoint") && a.geometry.frame !== undefined);
    if (shapes.length)
      out.push({
        id: "shapes",
        header: <span>Per-frame shapes</span>,
        items: shapes.map((a) => {
          const f = (a.geometry as { frame: number }).frame;
          return { kind: "instant", key: a.id, select: a.id, frame: f, marker: "tick", tint: tint(a.label), selected: selected.has(a.id), attrs: { "data-shape": a.id }, title: `${a.label} · frame ${f + 1}` };
        }),
      });

    for (const a of of("track")) {
      const g = a.geometry;
      const sel = selected.has(a.id);
      const kfs = sortKeyframes(g.keyframes);
      const color = tint(a.label);
      out.push({
        id: `track-${a.id}`,
        select: a.id,
        highlight: sel,
        guideFrom: kfs[0]?.frame,
        header: (
          <>
            {swatch(a.label)}
            <span className="tnum">#{numbers.get(a.id)}</span>
            <span className="truncate capitalize">{a.label}</span>
            <span className="ml-auto text-[10px] opacity-60">{g.shape === "box" ? "▭" : g.shape === "polygon" ? "⬠" : "•"}</span>
          </>
        ),
        items: [
          ...trackSpans(g, frames).map((s) => ({
            kind: "band" as const,
            key: `span-${s.start}`,
            start: s.start,
            end: s.end,
            background: s.occluded ? `repeating-linear-gradient(135deg, ${color(0.55)} 0 3px, transparent 3px 6px)` : color(sel ? 0.6 : 0.4),
          })),
          ...kfs.map((k) => ({
            kind: "instant" as const,
            key: `${a.id}:${k.frame}`,
            select: a.id,
            frame: k.frame,
            marker: "diamond" as const,
            tint: color,
            selected: sel,
            hollow: !!k.outside,
            draggable: editable(a),
            attrs: { "data-kf": `${a.id}:${k.frame}` },
            title: `Keyframe · frame ${k.frame + 1}${k.outside ? " · outside" : ""}${k.occluded ? " · occluded" : ""}`,
            meta: { a, from: k.frame },
          })),
        ],
      });
    }
    return out;
    // lockedLabels: editability is read from the store inside.
  }, [visible, selectedIds, tool, activeLabel, labels, numbers, frames, fps, lockedLabels]);

  return (
    <Timeline
      frames={frames}
      fps={fps}
      frame={p.frame}
      lanes={lanes}
      range={p.range}
      filmstrip={p.filmstrip}
      onSeek={p.onSeek}
      onRange={p.onRange}
      onSelect={(id) => useHost.getState().select(id)}
      onToggleSelect={(id) => useHost.getState().toggleSelect(id)}
      onSpanCreate={(laneId, start, end) => addSpan(itemId, laneId.slice("seg-".length), start, end)}
      onSpanChange={(it, start, end) => {
        const a = it.meta as Of<"span">;
        setGeometry(a.id, { ...a.geometry, start, end });
      }}
      onInstantCreate={(_lane, f) => {
        if (addInstant(itemId, f)) p.onSeek(f);
      }}
      onInstantMove={(it, to) => {
        if (it.marker === "diamond") {
          const { a, from } = it.meta as { a: Of<"track">; from: number };
          setGeometry(a.id, moveKeyframe(a.geometry, from, to));
        } else {
          const a = it.meta as Of<"instant">;
          setGeometry(a.id, { ...a.geometry, frame: to });
        }
      }}
    />
  );
}
