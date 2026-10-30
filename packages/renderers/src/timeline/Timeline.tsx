import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@studio/ui/utils";

/**
 * A frame-accurate time axis with lanes of span / instant annotations (todo phase 4,
 * kits/timeline). Domain-neutral: the host maps its annotations into lanes and items and
 * gets edits back as callbacks; the kit owns zoom, scroll, the ruler, the playhead, the
 * optional A–B range and filmstrip, and every drag gesture.
 *
 * Time is measured in frames (`frames` at `fps`); spans are given in seconds and snap to
 * frame boundaries while dragged. Zoom with Ctrl/⌘-wheel anywhere or plain wheel over the
 * ruler; scroll horizontally.
 */

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

/** Colour of an item at a given opacity (labels resolve their own colour space). */
export type Tint = (alpha?: number) => string;

interface ItemBase {
  /** Unique within the timeline. */
  key: string;
  /** Selection id (usually an annotation id) picked by clicking the item. */
  select: string;
  title?: string;
  /** Extra DOM attributes (`data-*` hooks for tests and tools). */
  attrs?: Record<string, string>;
  /** Opaque host data handed back with edits. */
  meta?: unknown;
}

/** A labelled span in seconds; editable spans drag by their edges or body. */
export interface SpanItem extends ItemBase {
  kind: "span";
  start: number;
  end: number;
  tint: Tint;
  selected?: boolean;
  editable?: boolean;
}

/** A point in time: a flag pin, a keyframe diamond or a thin tick. Draggable ones move along the lane. */
export interface InstantItem extends ItemBase {
  kind: "instant";
  frame: number;
  marker: "flag" | "diamond" | "tick";
  tint: Tint;
  selected?: boolean;
  draggable?: boolean;
  /** Drawn as an outline (e.g. an "outside" keyframe). */
  hollow?: boolean;
}

/** A non-interactive band over frames [start, end), e.g. where a track is visible. */
export interface BandItem {
  kind: "band";
  key: string;
  start: number;
  end: number;
  background: string;
}

export type TimelineItem = SpanItem | InstantItem | BandItem;

export interface TimelineLane {
  /** Row id (`data-row`). */
  id: string;
  header: React.ReactNode;
  /** Clicking the header or empty lane picks this selection id. */
  select?: string;
  /** Row highlighted (and header emphasised), e.g. when its object is selected. */
  highlight?: boolean;
  /** What a press on the empty lane creates: a span (drag) or an instant (click). Otherwise it scrubs. */
  create?: "span" | "instant";
  /** Tailwind cursor class for the empty lane. */
  cursor?: string;
  /** Dashed guide from this frame to the end (e.g. a track's lifetime). */
  guideFrom?: number;
  items: TimelineItem[];
}

export interface TimelineProps {
  frames: number;
  fps: number;
  /** Playhead frame. */
  frame: number;
  lanes: TimelineLane[];
  range: { a: number; b: number } | null;
  filmstrip: FilmstripSource | null;
  onSeek: (frame: number) => void;
  onRange: (r: { a: number; b: number } | null) => void;
  onSelect: (id: string | null) => void;
  /** Shift/⌘/Ctrl-click toggles membership in the selection. */
  onToggleSelect: (id: string) => void;
  onSpanCreate: (laneId: string, start: number, end: number) => void;
  onSpanChange: (item: SpanItem, start: number, end: number) => void;
  onInstantCreate: (laneId: string, frame: number) => void;
  /** A draggable instant moved; the playhead follows to `to` afterwards. */
  onInstantMove: (item: InstantItem, to: number) => void;
}

type Drag =
  | { kind: "scrub" }
  | { kind: "range"; a: number; b: number }
  | { kind: "spanCreate"; lane: string; a: number; b: number }
  | { kind: "spanEdit"; item: SpanItem; edge: "start" | "end" | "move"; x0: number; x: number; moved: boolean }
  | { kind: "instant"; item: InstantItem; frame: number; moved: boolean };

export function Timeline(p: TimelineProps) {
  const { frames, fps, frame } = p;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(600);
  const [scroll, setScroll] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const props = useRef(p);
  props.current = p;
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
    const target = (frame + 0.5) * fitPpf * z - viewW / 2;
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

  // --- Lane handlers (the lane element spans the full content width from x = 0). ---
  const laneDown = (e: React.PointerEvent, lane: Pick<TimelineLane, "id" | "create" | "select">) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    if (lane.create === "span") return begin(e, { kind: "spanCreate", lane: lane.id, a: frameAt(e, el, true), b: frameAt(e, el, true) });
    if (lane.create === "instant") return props.current.onInstantCreate(lane.id, frameAt(e, el));
    if (lane.select && pick(e, lane.select)) return;
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
      case "spanCreate":
        updateDrag({ ...d, b: frameAt(e, lane, true) });
        break;
      case "spanEdit": {
        const df = Math.round((e.clientX - d.x0) / ppfRef.current);
        if (!df && !d.moved) break;
        updateDrag({ ...d, x: e.clientX, moved: true });
        break;
      }
      case "instant": {
        const f = frameAt(e, lane);
        if (f !== d.frame) updateDrag({ ...d, frame: f, moved: true });
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
    } else if (d.kind === "spanCreate") {
      const a = Math.min(d.a, d.b), b = Math.max(d.a, d.b);
      if (b > a) P.onSpanCreate(d.lane, a / fps, b / fps);
    } else if (d.kind === "spanEdit" && d.moved) {
      const s = spanPreview(d);
      P.onSpanChange(d.item, s.start, s.end);
    } else if (d.kind === "instant" && d.moved) {
      P.onInstantMove(d.item, d.frame);
      P.onSeek(d.frame);
    }
  };

  /** Span bounds during an edge/body drag, snapped to frame boundaries. */
  const spanPreview = (d: Extract<Drag, { kind: "spanEdit" }>) => {
    const df = Math.round((d.x - d.x0) / ppfRef.current);
    const total = frames / fps;
    let { start, end } = d.item;
    if (d.edge === "start") start = Math.min(end - 1 / fps, Math.max(0, snap(d.item.start, fps) + df / fps));
    else if (d.edge === "end") end = Math.max(start + 1 / fps, Math.min(total, snap(d.item.end, fps) + df / fps));
    else {
      const len = d.item.end - d.item.start;
      start = Math.max(0, Math.min(total - len, snap(d.item.start, fps) + df / fps));
      end = start + len;
    }
    return { start: +start.toFixed(4), end: +end.toFixed(4) };
  };

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

  const renderItem = (it: TimelineItem) => {
    if (it.kind === "band") return <div key={it.key} className="absolute bottom-[3px] top-[3px] rounded-[2px]" style={{ left: x(it.start), width: Math.max(1, x(it.end - it.start)), background: it.background }} />;
    if (it.kind === "span") {
      const live = drag?.kind === "spanEdit" && drag.item.key === it.key && drag.moved ? spanPreview(drag) : it;
      return (
        <div
          key={it.key}
          {...it.attrs}
          title={it.title}
          className={cn("absolute bottom-0.5 top-0.5 overflow-hidden rounded-sm px-1 text-[10px] leading-[14px] text-white", it.selected && "ring-2 ring-white/90", it.editable ? "cursor-grab" : "cursor-pointer")}
          style={{ left: live.start * fps * ppf, width: Math.max(2, (live.end - live.start) * fps * ppf), background: it.tint(it.selected ? 0.8 : 0.55) }}
          onPointerDown={(e) => {
            if (e.button !== 0 || pick(e, it.select)) return;
            if (!it.editable) return e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            const edge = e.clientX - r.left < 6 ? "start" : r.right - e.clientX < 6 ? "end" : "move";
            begin(e, { kind: "spanEdit", item: it, edge, x0: e.clientX, x: e.clientX, moved: false });
          }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onDoubleClick={() => props.current.onSeek(Math.round(it.start * fps))}
        >
          <span className="pointer-events-none truncate">{(live.end - live.start).toFixed(1)}s</span>
          {it.editable && it.selected && (
            <>
              <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/50" />
              <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/50" />
            </>
          )}
        </div>
      );
    }
    const f = drag?.kind === "instant" && drag.item.key === it.key ? drag.frame : it.frame;
    const down = (e: React.PointerEvent) => {
      if (e.button !== 0 || pick(e, it.select)) return;
      props.current.onSeek(it.frame);
      if (it.draggable) begin(e, { kind: "instant", item: it, frame: it.frame, moved: false });
      else e.stopPropagation();
    };
    const common = { ...it.attrs, title: it.title, onPointerDown: down, onPointerMove: onMove, onPointerUp: onUp };
    if (it.marker === "tick")
      return <div key={it.key} {...common} className={cn("absolute bottom-1 top-1 rounded-[1px]", it.selected && "ring-2 ring-white")} style={{ left: x(f) + Math.max(0, ppf / 2 - 2), width: Math.max(3, Math.min(ppf, 4)), background: it.tint() }} />;
    if (it.marker === "diamond")
      return (
        <div
          key={it.key}
          {...common}
          className="absolute top-1/2 z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-grab border"
          style={{ left: x(f + 0.5), background: it.hollow ? "transparent" : it.tint(), borderColor: it.selected ? "#fff" : it.hollow ? it.tint() : "rgba(0,0,0,0.5)" }}
        />
      );
    return (
      <div key={it.key} {...common} className={cn("absolute top-0.5 flex h-[14px] -translate-x-1/2 cursor-grab items-start", it.selected && "z-10")} style={{ left: x(f + 0.5) }}>
        <svg width="10" height="14" viewBox="0 0 10 14">
          <path d="M1 0 V14" style={{ stroke: it.tint() }} strokeWidth="2" />
          <path d="M2 1 H9 L7 4 L9 7 H2 Z" style={{ fill: it.tint(), stroke: it.selected ? "#fff" : "none" }} strokeWidth="1" />
        </svg>
      </div>
    );
  };

  const rows = useMemo(
    () =>
      p.lanes.map((lane) => (
        <div key={lane.id} data-row={lane.id} className={cn("flex border-b border-white/5", lane.highlight && "bg-white/[0.06]")} style={{ height: LANE_H }}>
          <div
            onClick={lane.select ? (e) => pick(e, lane.select!) : undefined}
            className={cn(
              "sticky left-0 z-20 flex shrink-0 items-center gap-1.5 truncate border-r border-white/10 bg-canvas px-2",
              lane.select && "cursor-pointer hover:text-canvas-foreground",
              lane.highlight ? "text-canvas-foreground" : "text-canvas-foreground/65",
            )}
            style={{ width: HEADER, height: LANE_H }}
          >
            {lane.header}
          </div>
          <div data-lane className={cn("relative", lane.cursor ?? "cursor-pointer")} style={{ width: contentW }} onPointerDown={(e) => laneDown(e, lane)} onPointerMove={onMove} onPointerUp={onUp}>
            {lane.guideFrom !== undefined && <div className="absolute top-1/2 h-px border-t border-dashed border-canvas-foreground/25" style={{ left: x(lane.guideFrom), width: x(frames - lane.guideFrom) }} />}
            {lane.items.map(renderItem)}
            {drag?.kind === "spanCreate" && drag.lane === lane.id && (
              <div className="absolute bottom-0.5 top-0.5 rounded-sm border border-white/70 bg-white/20" style={{ left: x(Math.min(drag.a, drag.b)), width: Math.abs(drag.b - drag.a) * ppf }} />
            )}
          </div>
        </div>
      )),
    // Handlers read the latest props through refs; frame changes don't rebuild the lanes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.lanes, ppf, contentW, frames, fps, drag],
  );

  const lanesHeight = p.lanes.length * LANE_H + RULER_H + (p.filmstrip ? FILM_H : 0);

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
              <div data-lane className="relative cursor-pointer" style={{ width: contentW }} onPointerDown={(e) => laneDown(e, { id: "filmstrip" })} onPointerMove={onMove} onPointerUp={onUp}>
                <Filmstrip source={p.filmstrip} frames={frames} ppf={ppf} scroll={scroll} width={viewW} />
              </div>
            </div>
          )}

          {rows}

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
