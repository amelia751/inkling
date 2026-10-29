import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { labelColor } from "@/lib/labels";
import { cn } from "@/lib/utils";
import type { Tool } from "@/stores/studio";
import type { Annotation, Geometry } from "@/types";
import { formatTime } from "@/kits/viewport-chrome/format";
import { moveKeyframe, sortKeyframes, trackSpans } from "./tracks";

const HEADER = 132;
const RULER_H = 22;
const LANE_H = 18;
const FILM_H = 36;
const MAX_PPF = 60;
const NICE = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000];

export interface FilmstripSource {
  get: (frame: number) => CanvasImageSource | undefined;
  load: (frames: number[]) => void;
  /** Width / height of a frame. */
  aspect: number;
  /** Bumps when new thumbnails arrive. */
  version: number;
}

export interface TimelineProps {
  frames: number;
  fps: number;
  /** Playhead frame. */
  frame: number;
  labels: string[];
  /** The item's visible annotations. */
  annotations: Annotation[];
  numbers: Map<string, number>;
  selectedId: string | null;
  /** Every selected annotation; Shift/⌘/Ctrl-click toggles membership. */
  selectedIds: string[];
  tool: Tool;
  activeLabel: string | null;
  range: { a: number; b: number } | null;
  editable: (a: Annotation) => boolean;
  filmstrip: FilmstripSource | null;
  onSeek: (frame: number) => void;
  onRange: (r: { a: number; b: number } | null) => void;
  onSelect: (id: string | null) => void;
  onToggleSelect: (id: string) => void;
  onCreateSegment: (label: string, start: number, end: number) => void;
  onCreateEvent: (frame: number) => void;
  onGeometry: (id: string, g: Geometry) => void;
}

type Drag =
  | { kind: "scrub" }
  | { kind: "range"; a: number; b: number }
  | { kind: "segCreate"; label: string; a: number; b: number }
  | { kind: "segEdit"; id: string; edge: "start" | "end" | "move"; x0: number; x: number; start: number; end: number; moved: boolean }
  | { kind: "event"; id: string; frame: number; moved: boolean }
  | { kind: "kf"; id: string; from: number; to: number; moved: boolean };

/**
 * Frame-accurate timeline: ruler (click/drag to scrub, Shift-drag for an A–B range),
 * optional filmstrip, an event lane, one segment lane per label and one lane per object
 * track (visible spans, keyframe diamonds, outside gaps, hatched occlusion). Zoom with
 * Ctrl/⌘-wheel anywhere or plain wheel over the ruler; scroll horizontally.
 */
export function Timeline(p: TimelineProps) {
  const { frames, fps, frame, labels } = p;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(600);
  const [scroll, setScroll] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const props = useRef(p);
  props.current = p;
  const selected = useMemo(() => new Set(p.selectedIds), [p.selectedIds]);
  /** Select on click; with Shift/⌘/Ctrl toggle instead and report true (no drag, no seek). */
  const pick = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; stopPropagation?: () => void }, id: string) => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.stopPropagation?.();
      props.current.onToggleSelect(id);
      return true;
    }
    props.current.onSelect(id);
    return false;
  };

  const fitPpf = viewW / Math.max(1, frames);
  const maxZoom = Math.max(1, MAX_PPF / fitPpf);
  const ppf = fitPpf * Math.min(zoom, maxZoom);
  const contentW = Math.max(viewW, frames * ppf);
  const ppfRef = useRef(ppf);
  ppfRef.current = ppf;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(Math.max(100, el.clientWidth - HEADER)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel zoom must be a non-passive listener so Ctrl-wheel doesn't zoom the page.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const overRuler = (e.target as HTMLElement).closest?.("[data-ruler]");
      const canScrollY = el.scrollHeight > el.clientHeight + 1;
      const vertical = Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey;
      if (!(e.ctrlKey || e.metaKey || (vertical && (overRuler || !canScrollY)))) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = Math.max(0, e.clientX - rect.left - HEADER);
      const at = (el.scrollLeft + cx) / ppfRef.current;
      setZoom((z) => {
        const next = Math.max(1, Math.min(MAX_PPF / (el.clientWidth - HEADER) * frames, z * Math.exp(-e.deltaY * 0.002)));
        pendingScroll.current = at * fitPpfOf(el, frames) * next - cx;
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [frames]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingScroll.current !== null) {
      el.scrollLeft = Math.max(0, pendingScroll.current);
      pendingScroll.current = null;
      setScroll(el.scrollLeft);
    }
  }, [zoom]);

  // Keep the playhead in view (pages forward during playback).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || dragRef.current) return;
    const x = (frame + 0.5) * ppf;
    if (x < el.scrollLeft || x > el.scrollLeft + viewW) el.scrollLeft = Math.max(0, x - viewW * 0.15);
  }, [frame, ppf, viewW]);

  const setZoomCentered = (next: number) => {
    const el = scrollRef.current;
    const z = Math.max(1, Math.min(maxZoom, next));
    const at = frame + 0.5;
    const target = at * fitPpf * z - viewW / 2;
    if (z === zoom) {
      if (el) el.scrollLeft = Math.max(0, target);
      return;
    }
    pendingScroll.current = target;
    setZoom(z);
  };

  const frameAt = (e: { clientX: number }, el: Element, boundary = false) => {
    const x = (e.clientX - el.getBoundingClientRect().left) / ppfRef.current;
    return Math.max(0, Math.min(boundary ? frames : frames - 1, boundary ? Math.round(x) : Math.floor(x)));
  };

  const begin = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = d;
    setDrag(d);
  };
  const updateDrag = (d: Drag) => {
    dragRef.current = d;
    setDrag(d);
  };

  // --- Lane content handlers (the lane element spans the full content width from x = 0). ---
  const laneDown = (e: React.PointerEvent, opts: { segmentLabel?: string; events?: boolean; trackId?: string }) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    const { tool, activeLabel } = props.current;
    if (opts.segmentLabel && tool === "segment") {
      const f = frameAt(e, el, true);
      begin(e, { kind: "segCreate", label: opts.segmentLabel, a: f, b: f });
      return;
    }
    if (opts.events && tool === "event" && activeLabel) {
      props.current.onCreateEvent(frameAt(e, el));
      return;
    }
    if (opts.trackId && pick(e, opts.trackId)) return;
    props.current.onSeek(frameAt(e, el));
    begin(e, { kind: "scrub" });
  };

  const onMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    const lane = (e.currentTarget as HTMLElement).closest("[data-lane]") ?? e.currentTarget;
    switch (d.kind) {
      case "scrub":
        props.current.onSeek(frameAt(e, lane));
        break;
      case "range":
        updateDrag({ ...d, b: frameAt(e, lane) });
        break;
      case "segCreate":
        updateDrag({ ...d, b: frameAt(e, lane, true) });
        break;
      case "segEdit": {
        const df = Math.round((e.clientX - d.x0) / ppfRef.current);
        if (!df && !d.moved) break;
        updateDrag({ ...d, x: e.clientX, moved: true });
        break;
      }
      case "event":
      case "kf": {
        const f = frameAt(e, lane);
        if (d.kind === "event" && f !== d.frame) updateDrag({ ...d, frame: f, moved: true });
        if (d.kind === "kf" && f !== d.to) updateDrag({ ...d, to: f, moved: true });
        break;
      }
    }
  };

  const onUp = (e: React.PointerEvent) => {
    e.stopPropagation();
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    const P = props.current;
    if (d.kind === "range") {
      const a = Math.min(d.a, d.b), b = Math.max(d.a, d.b);
      P.onRange(b > a ? { a, b } : null);
    } else if (d.kind === "segCreate") {
      const a = Math.min(d.a, d.b), b = Math.max(d.a, d.b);
      if (b > a) P.onCreateSegment(d.label, a / fps, b / fps);
    } else if (d.kind === "segEdit" && d.moved) {
      const s = segPreview(d);
      if (s) P.onGeometry(d.id, { type: "segment", start: s.start, end: s.end });
    } else if (d.kind === "event" && d.moved) {
      P.onGeometry(d.id, { type: "event", frame: d.frame });
      P.onSeek(d.frame);
    } else if (d.kind === "kf" && d.moved) {
      const a = P.annotations.find((x) => x.id === d.id);
      if (a?.geometry.type === "track") P.onGeometry(d.id, moveKeyframe(a.geometry, d.from, d.to));
      P.onSeek(d.to);
    }
  };

  /** Segment bounds during an edge/body drag, snapped to frame boundaries. */
  const segPreview = (d: Extract<Drag, { kind: "segEdit" }>) => {
    const df = Math.round((d.x - d.x0) / ppfRef.current);
    const total = frames / fps;
    let start = d.start, end = d.end;
    if (d.edge === "start") start = Math.min(end - 1 / fps, Math.max(0, snap(d.start, fps) + df / fps));
    else if (d.edge === "end") end = Math.max(start + 1 / fps, Math.min(total, snap(d.end, fps) + df / fps));
    else {
      const len = d.end - d.start;
      start = Math.max(0, Math.min(total - len, snap(d.start, fps) + df / fps));
      end = start + len;
    }
    return { start: +start.toFixed(4), end: +end.toFixed(4) };
  };

  const segments = p.annotations.filter((a) => a.geometry.type === "segment");
  const events = p.annotations.filter((a) => a.geometry.type === "event");
  const tracks = p.annotations.filter((a) => a.geometry.type === "track");
  const shapes = p.annotations.filter((a) => (a.geometry.type === "box" || a.geometry.type === "polygon" || a.geometry.type === "keypoint") && a.geometry.frame !== undefined);
  const x = (f: number) => f * ppf;

  // ---- Ruler ticks (only the visible window) ----
  const step = NICE.find((s) => s * ppf >= 56) ?? NICE[NICE.length - 1];
  const minor = [step / 5, step / 2].find((m) => Number.isInteger(m) && m * ppf >= 6) ?? (ppf >= 6 ? 1 : 0);
  const f0 = Math.max(0, Math.floor(scroll / ppf) - step);
  const f1 = Math.min(frames, Math.ceil((scroll + viewW) / ppf) + step);
  const ticks: React.ReactNode[] = [];
  if (minor) for (let f = Math.ceil(f0 / minor) * minor; f <= f1; f += minor) if (f % step) ticks.push(<div key={`m${f}`} className="absolute bottom-0 h-1.5 w-px bg-canvas-foreground/25" style={{ left: x(f) }} />);
  for (let f = Math.ceil(f0 / step) * step; f <= f1; f += step)
    ticks.push(
      <div key={`M${f}`} className="absolute bottom-0 top-1 border-l border-canvas-foreground/40 pl-1 leading-none text-canvas-foreground/60" style={{ left: x(f) }}>
        <span className="tnum">{f + 1}</span>
      </div>,
    );

  const rangeView = drag?.kind === "range" ? { a: Math.min(drag.a, drag.b), b: Math.max(drag.a, drag.b) } : p.range;

  const lanes = useMemo(() => {
    const out: React.ReactNode[] = [];
    const color = (label: string, alpha = 1) => labelColor(labels, label, alpha);
    const header = (key: string, content: React.ReactNode, isSelected = false, onClick?: (e: React.MouseEvent) => void) => (
      <div
        key={key}
        onClick={onClick}
        className={cn(
          "sticky left-0 z-20 flex shrink-0 items-center gap-1.5 truncate border-r border-white/10 bg-canvas px-2",
          onClick && "cursor-pointer hover:text-canvas-foreground",
          isSelected ? "text-canvas-foreground" : "text-canvas-foreground/65",
        )}
        style={{ width: HEADER, height: LANE_H }}
      >
        {content}
      </div>
    );
    const swatch = (label: string) => <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: color(label) }} />;

    // Events
    out.push(
      <div key="events" data-row="events" className="flex border-b border-white/5" style={{ height: LANE_H }}>
        {header("h", <span>Events</span>)}
        <div data-lane className={cn("relative", p.tool === "event" ? "cursor-copy" : "cursor-pointer")} style={{ width: contentW }} onPointerDown={(e) => laneDown(e, { events: true })} onPointerMove={onMove} onPointerUp={onUp}>
          {events.map((a) => {
            const g = a.geometry as Extract<Geometry, { type: "event" }>;
            const f = drag?.kind === "event" && drag.id === a.id ? drag.frame : g.frame;
            const sel = selected.has(a.id);
            return (
              <div
                key={a.id} data-event={a.id}
                title={`${a.label} · frame ${g.frame + 1} · ${formatTime(g.frame / fps)}`}
                className={cn("absolute top-0.5 flex h-[14px] -translate-x-1/2 cursor-grab items-start", sel && "z-10")}
                style={{ left: x(f + 0.5) }}
                onPointerDown={(e) => {
                  if (e.button !== 0 || pick(e, a.id)) return;
                  props.current.onSeek(g.frame);
                  if (props.current.editable(a)) begin(e, { kind: "event", id: a.id, frame: g.frame, moved: false });
                  else e.stopPropagation();
                }}
                onPointerMove={onMove}
                onPointerUp={onUp}
              >
                <svg width="10" height="14" viewBox="0 0 10 14">
                  <path d="M1 0 V14" style={{ stroke: color(a.label) }} strokeWidth="2" />
                  <path d="M2 1 H9 L7 4 L9 7 H2 Z" style={{ fill: color(a.label), stroke: sel ? "#fff" : "none" }} strokeWidth="1" />
                </svg>
              </div>
            );
          })}
        </div>
      </div>,
    );

    // One segment lane per label
    for (const label of labels) {
      const mine = segments.filter((a) => a.label === label);
      out.push(
        <div key={`seg-${label}`} data-row={`seg-${label}`} className="flex border-b border-white/5" style={{ height: LANE_H }}>
          {header("h", <>{swatch(label)}<span className="truncate capitalize">{label}</span></>, false)}
          <div
            data-lane
            className={cn("relative", p.tool === "segment" ? "cursor-crosshair" : "cursor-pointer")}
            style={{ width: contentW }}
            onPointerDown={(e) => laneDown(e, { segmentLabel: label })}
            onPointerMove={onMove}
            onPointerUp={onUp}
          >
            {mine.map((a) => {
              const g = a.geometry as Extract<Geometry, { type: "segment" }>;
              const live = drag?.kind === "segEdit" && drag.id === a.id && drag.moved ? segPreview(drag) : g;
              const sel = selected.has(a.id);
              const edit = p.editable(a);
              return (
                <div
                  key={a.id} data-seg={a.id}
                  title={`${a.label} · ${formatTime(g.start)}–${formatTime(g.end)} (${(g.end - g.start).toFixed(2)} s)`}
                  className={cn("absolute bottom-0.5 top-0.5 overflow-hidden rounded-sm px-1 text-[10px] leading-[14px] text-white", sel && "ring-2 ring-white/90", edit ? "cursor-grab" : "cursor-pointer")}
                  style={{ left: live.start * fps * ppf, width: Math.max(2, (live.end - live.start) * fps * ppf), background: color(a.label, sel ? 0.8 : 0.55) }}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || pick(e, a.id)) return;
                    if (!edit) return e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    const edge = e.clientX - r.left < 6 ? "start" : r.right - e.clientX < 6 ? "end" : "move";
                    begin(e, { kind: "segEdit", id: a.id, edge, x0: e.clientX, x: e.clientX, start: g.start, end: g.end, moved: false });
                  }}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onDoubleClick={() => props.current.onSeek(Math.round(g.start * fps))}
                >
                  <span className="pointer-events-none truncate">{(live.end - live.start).toFixed(1)}s</span>
                  {edit && sel && (
                    <>
                      <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/50" />
                      <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/50" />
                    </>
                  )}
                </div>
              );
            })}
            {drag?.kind === "segCreate" && drag.label === label && (
              <div className="absolute bottom-0.5 top-0.5 rounded-sm border border-white/70 bg-white/20" style={{ left: x(Math.min(drag.a, drag.b)), width: Math.abs(drag.b - drag.a) * ppf }} />
            )}
          </div>
        </div>,
      );
    }

    // Per-frame shapes (legacy boxes etc.)
    if (shapes.length)
      out.push(
        <div key="shapes" data-row="shapes" className="flex border-b border-white/5" style={{ height: LANE_H }}>
          {header("h", <span>Per-frame shapes</span>)}
          <div data-lane className="relative cursor-pointer" style={{ width: contentW }} onPointerDown={(e) => laneDown(e, {})} onPointerMove={onMove} onPointerUp={onUp}>
            {shapes.map((a) => {
              const f = (a.geometry as { frame: number }).frame;
              return (
                <div
                  key={a.id} data-shape={a.id}
                  title={`${a.label} · frame ${f + 1}`}
                  className={cn("absolute bottom-1 top-1 rounded-[1px]", selected.has(a.id) && "ring-2 ring-white")}
                  style={{ left: x(f) + Math.max(0, ppf / 2 - 2), width: Math.max(3, Math.min(ppf, 4)), background: color(a.label) }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (pick(e, a.id)) return;
                    props.current.onSeek(f);
                  }}
                />
              );
            })}
          </div>
        </div>,
      );

    // One lane per track
    for (const a of tracks) {
      const g = a.geometry as Extract<Geometry, { type: "track" }>;
      const sel = selected.has(a.id);
      const live = drag?.kind === "kf" && drag.id === a.id && drag.moved ? moveKeyframe(g, drag.from, drag.to) : g;
      const kfs = sortKeyframes(live.keyframes);
      const spans = trackSpans(live, frames);
      const n = p.numbers.get(a.id);
      out.push(
        <div key={a.id} data-row={`track-${a.id}`} className={cn("flex border-b border-white/5", sel && "bg-white/[0.06]")} style={{ height: LANE_H }}>
          {header(
            "h",
            <>
              {swatch(a.label)}
              <span className="tnum">#{n}</span>
              <span className="truncate capitalize">{a.label}</span>
              <span className="ml-auto text-[10px] opacity-60">{g.shape === "box" ? "▭" : g.shape === "polygon" ? "⬠" : "•"}</span>
            </>,
            sel,
            (e) => pick(e, a.id),
          )}
          <div data-lane className="relative cursor-pointer" style={{ width: contentW }} onPointerDown={(e) => laneDown(e, { trackId: a.id })} onPointerMove={onMove} onPointerUp={onUp}>
            {kfs.length > 0 && <div className="absolute top-1/2 h-px border-t border-dashed border-canvas-foreground/25" style={{ left: x(kfs[0].frame), width: x(frames - kfs[0].frame) }} />}
            {spans.map((s) => (
              <div
                key={s.start}
                className="absolute bottom-[3px] top-[3px] rounded-[2px]"
                style={{
                  left: x(s.start),
                  width: Math.max(1, x(s.end - s.start)),
                  background: s.occluded
                    ? `repeating-linear-gradient(135deg, ${color(a.label, 0.55)} 0 3px, transparent 3px 6px)`
                    : color(a.label, sel ? 0.6 : 0.4),
                }}
              />
            ))}
            {kfs.map((k) => (
              <div
                key={k.frame} data-kf={`${a.id}:${k.frame}`}
                title={`Keyframe · frame ${k.frame + 1}${k.outside ? " · outside" : ""}${k.occluded ? " · occluded" : ""}`}
                className="absolute top-1/2 z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-grab border"
                style={{
                  left: x(k.frame + 0.5),
                  background: k.outside ? "transparent" : color(a.label),
                  borderColor: sel ? "#fff" : k.outside ? color(a.label) : "rgba(0,0,0,0.5)",
                }}
                onPointerDown={(e) => {
                  if (e.button !== 0 || pick(e, a.id)) return;
                  props.current.onSeek(k.frame);
                  if (props.current.editable(a)) begin(e, { kind: "kf", id: a.id, from: k.frame, to: k.frame, moved: false });
                  else e.stopPropagation();
                }}
                onPointerMove={onMove}
                onPointerUp={onUp}
              />
            ))}
          </div>
        </div>,
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.annotations, selected, p.tool, p.numbers, labels, ppf, contentW, frames, fps, drag]);

  const lanesHeight = (1 + labels.length + (shapes.length ? 1 : 0) + tracks.length) * LANE_H + RULER_H + (p.filmstrip ? FILM_H : 0);

  return (
    <div className="flex flex-col text-[11px]">
      <div ref={scrollRef} className="relative overflow-auto overscroll-contain" style={{ maxHeight: 236 }} onScroll={(e) => setScroll(e.currentTarget.scrollLeft)} data-testid="timeline">
        <div className="relative select-none" style={{ width: HEADER + contentW, height: lanesHeight }}>
          {/* Ruler */}
          <div className="sticky top-0 z-30 flex border-b border-white/10 bg-canvas" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r border-white/10 bg-canvas px-1" style={{ width: HEADER }}>
              <ZoomButton label="Zoom out timeline" onClick={() => setZoomCentered(zoom / 1.6)}>−</ZoomButton>
              <ZoomButton label="Fit timeline" onClick={() => setZoomCentered(1)}>
                {Math.round(Math.min(zoom, maxZoom) * 100)}%
              </ZoomButton>
              <ZoomButton label="Zoom in timeline" onClick={() => setZoomCentered(zoom * 1.6)}>+</ZoomButton>
            </div>
            <div
              data-lane
              data-ruler
              className="relative cursor-pointer overflow-hidden"
              style={{ width: contentW }}
              title="Click or drag to scrub · Shift-drag to set an A–B loop range"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                const f = frameAt(e, e.currentTarget);
                if (e.shiftKey) begin(e, { kind: "range", a: f, b: f });
                else {
                  p.onSeek(f);
                  begin(e, { kind: "scrub" });
                }
              }}
              onPointerMove={onMove}
              onPointerUp={onUp}
            >
              {ticks}
              {rangeView && <div className="absolute inset-y-0 border-x-2 border-primary bg-primary/25" style={{ left: x(rangeView.a), width: x(rangeView.b - rangeView.a + 1) }} />}
              <div className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-sm bg-primary px-1 text-[10px] leading-[14px] text-primary-foreground tnum" style={{ left: x(frame + 0.5) }}>
                {frame + 1}
              </div>
            </div>
          </div>

          {p.filmstrip && (
            <div className="flex border-b border-white/10" style={{ height: FILM_H }}>
              <div className="sticky left-0 z-20 flex shrink-0 items-center border-r border-white/10 bg-canvas px-2 text-canvas-foreground/65" style={{ width: HEADER }}>
                Frames
              </div>
              <div data-lane className="relative cursor-pointer" style={{ width: contentW }} onPointerDown={(e) => laneDown(e, {})} onPointerMove={onMove} onPointerUp={onUp}>
                <Filmstrip source={p.filmstrip} frames={frames} ppf={ppf} scroll={scroll} width={viewW} />
              </div>
            </div>
          )}

          {lanes}

          {/* A–B range and playhead span every lane */}
          {rangeView && (
            <div className="pointer-events-none absolute bottom-0 z-[5] bg-primary/[0.07]" style={{ top: RULER_H, left: HEADER + x(rangeView.a), width: x(rangeView.b - rangeView.a + 1) }} />
          )}
          <div className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-primary" style={{ left: HEADER + x(frame + 0.5) }} />
        </div>
      </div>
    </div>
  );
}

function fitPpfOf(el: HTMLElement, frames: number) {
  return Math.max(100, el.clientWidth - HEADER) / Math.max(1, frames);
}

const snap = (t: number, fps: number) => Math.round(t * fps) / fps;

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="tnum min-w-5 rounded px-1 leading-4 text-canvas-foreground/70 hover:bg-white/10 hover:text-canvas-foreground">
      {children}
    </button>
  );
}

/** Low-res frame thumbnails for the visible window, decoded lazily. */
function Filmstrip({ source, frames, ppf, scroll, width }: { source: FilmstripSource; frames: number; ppf: number; scroll: number; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const tw = Math.max(24, Math.round(FILM_H * source.aspect));
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = FILM_H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, FILM_H);
    const total = frames * ppf;
    const need: number[] = [];
    for (let k = Math.floor(scroll / tw); k * tw < Math.min(total, scroll + width); k++) {
      const f = Math.min(frames - 1, Math.floor(((k + 0.5) * tw) / ppf));
      const img = source.get(f);
      const dx = k * tw - scroll;
      if (img) ctx.drawImage(img, dx, 1, Math.min(tw, total - k * tw) - 1, FILM_H - 2);
      else {
        need.push(f);
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(dx, 1, tw - 1, FILM_H - 2);
      }
    }
    if (need.length) source.load(need);
  }, [source, source.version, frames, ppf, scroll, width, tw]);
  return <canvas ref={ref} className="pointer-events-none absolute top-0" style={{ left: scroll, width, height: FILM_H }} />;
}
