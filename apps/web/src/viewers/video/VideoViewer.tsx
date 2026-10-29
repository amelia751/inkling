import { labelNames } from "@/platform/environment";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronLeftIcon as ChevronLeft, ChevronRightIcon as ChevronRight, CopyIcon as Copy, KeyframeIcon as Diamond, HideIcon as EyeOff, PauseIcon as Pause, PlayIcon as Play, LoopIcon as Repeat, FitIcon as Scan, SkipBackIcon as SkipBack, SkipForwardIcon as SkipForward, SettingsIcon as SlidersHorizontal, RegionIcon as SquareDashed, StepBackIcon as StepBack, StepForwardIcon as StepForward, CloseIcon as X, ZoomInIcon as ZoomIn, ZoomOutIcon as ZoomOut } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { seedUrl } from "@/lib/api";
import { useHotkeys } from "@/lib/hotkeys";
import { resolveLabelColor } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { BarIconButton, BarTextButton } from "@/kits/viewport-chrome/controls";
import { isEditable, newAnnotation, useStudio, visibleFor } from "@/stores/studio";
import type { Annotation, Geometry, Pt } from "@/types";
import { CanvasNotice } from "@/kits/viewport-chrome/CanvasNotice";
import { CLOSE_RADIUS } from "@/kits/overlay2d/draw";
import { formatTime } from "@/kits/viewport-chrome/format";
import { useCanvasSize } from "@/kits/viewport-chrome/useCanvasSize";
import { useViewport2D } from "@/kits/overlay2d/useViewport2D";
import type { ViewerProps } from "@/viewers/ViewerAdapter";
import { FrameSource } from "@/kits/io/frameSource";
import { drawDraft, drawRenderables, HANDLE_CURSORS, hitTest, resizeBox, translateShape, type Hit, type Renderable } from "./overlay";
import { Timeline, type FilmstripSource } from "./Timeline";
import {
  applyShape,
  isSpatial,
  keyframeAt,
  nextTrackId,
  round2,
  shapeAt,
  shapeOnFrame,
  sortKeyframes,
  toggleKeyframe,
  toggleOccluded,
  toggleOutside,
  trackNumbers,
  type Box,
  type FrameShape,
  type TrackGeometry,
} from "./tracks";

const RATES = [0.25, 0.5, 1, 1.5, 2];

/** Frame shown by the mounted video viewer; the selection inspector reads it for "at frame n" rows. */
export const videoPlayhead: { itemId: string | null; frame: number } = { itemId: null, frame: 0 };

/** "Per-frame shape" drawing mode survives switching videos. */
let perFrameDefault = false;

type Mode = "loading" | "exact" | "video";
type ShapeData = { box?: Box; points?: Pt[] };
type Action =
  | { kind: "pan" }
  | { kind: "draw-box"; a: Pt; b: Pt }
  | { kind: "edit"; id: string; part: Hit["part"]; index: number; start: Pt; orig: FrameShape; live: ShapeData | null };

/** Remount per item so decoder, clock and camera state never leak between videos. */
export function VideoViewer(props: ViewerProps) {
  return <VideoStage key={props.item.id} {...props} />;
}

function VideoStage({ project, item }: ViewerProps) {
  const asset = item.assets[0];
  const fps = asset.fps ?? 25;
  const url = seedUrl(asset.path);
  const labels = useMemo(() => labelNames(project.labels), [project.labels]);

  const tool = useStudio((s) => s.tool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const annotations = useStudio((s) => s.annotations);
  const selectedId = useStudio((s) => s.selectedId);
  const selectedIds = useStudio((s) => s.selectedIds);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const hiddenLabels = useStudio((s) => s.hiddenLabels);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const overlayOpacity = useStudio((s) => s.overlayOpacity);
  const add = useStudio((s) => s.add);
  const update = useStudio((s) => s.update);
  const select = useStudio((s) => s.select);
  const toggleSelect = useStudio((s) => s.toggleSelect);
  const batch = useStudio((s) => s.batch);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);

  // ---------------------------------------------------------------- decoding & clock
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<FrameSource | null>(null);
  const [mode, setMode] = useState<Mode>("loading");
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frames, setFrames] = useState(Math.max(1, asset.frames ?? Math.round((asset.duration ?? 0) * fps)));
  const [dims, setDims] = useState({ width: asset.width ?? 0, height: asset.height ?? 0 });
  const [thumbVersion, setThumbVersion] = useState(0);
  /** Frame on screen (overlays and edits use this) vs. frame asked for (playhead, readout). */
  const [frame, setFrame] = useState(0);
  const [target, setTarget] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(false);
  const [range, setRange] = useState<{ a: number; b: number } | null>(null);
  const [perFrame, setPerFrame] = useState(perFrameDefault);
  const [adjust, setAdjust] = useState({ brightness: 100, contrast: 100, saturation: 100 });

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const framesRef = useRef(frames);
  framesRef.current = frames;
  const targetRef = useRef(0);
  const frameRef = useRef(0);
  frameRef.current = frame;
  const playingRef = useRef(false);
  const lastPresented = useRef(0);
  const seekAfterPause = useRef<number | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const shownCanvas = useRef<unknown>(null);
  /** Element time at which frame 0 is presented (calibrated from requestVideoFrameCallback). */
  const clock = useRef({ base: 0, calibrated: false, ready: false });
  const [clockReady, setClockReady] = useState(false);
  const videoSeekFrame = useRef<number | null>(null);

  /** Seconds from frame 0's start to frame f's start. */
  const relTime = useCallback((f: number) => {
    const s = sourceRef.current;
    return s?.frameCount ? s.timestamps[Math.min(f, s.frameCount - 1)] - s.timestamps[0] : f / fps;
  }, [fps]);
  /** Where to put `<video>.currentTime` so frame f is presented (a quarter frame in, away from boundaries). */
  const videoTimeOf = useCallback((f: number) => clock.current.base + relTime(f) + 0.25 / fps, [relTime, fps]);
  const frameOfMediaTime = useCallback(
    (t: number) => {
      const s = sourceRef.current;
      const rel = t - clock.current.base;
      const f = s?.frameCount ? s.frameAt(rel + s.timestamps[0]) : Math.round(rel * fps);
      return Math.max(0, Math.min(framesRef.current - 1, f));
    },
    [fps],
  );

  const showFrameCanvas = (on: boolean) => {
    if (frameCanvasRef.current) frameCanvasRef.current.style.visibility = on ? "visible" : "hidden";
  };

  /** Put a decoded frame on screen and move the overlays to it in the same paint. */
  const present = useCallback((f: number, canvas: HTMLCanvasElement | OffscreenCanvas) => {
    const fc = frameCanvasRef.current;
    if (!fc || playingRef.current) return;
    if (shownCanvas.current !== canvas) {
      if (fc.width !== canvas.width || fc.height !== canvas.height) {
        fc.width = canvas.width;
        fc.height = canvas.height;
      }
      fc.getContext("2d")!.drawImage(canvas, 0, 0);
      shownCanvas.current = canvas;
    }
    showFrameCanvas(true);
    lastPresented.current = f;
    flushSync(() => setFrame(f));
  }, []);

  const fallBack = useCallback((reason: string) => {
    sourceRef.current?.dispose();
    sourceRef.current = null;
    showFrameCanvas(false);
    setFallbackReason(reason);
    modeRef.current = "video";
    setMode("video");
    // Until the element's clock is known, finishClock() seeks to the target itself.
    const v = videoRef.current;
    if (v && !playingRef.current && v.readyState >= 1 && clock.current.ready) {
      videoSeekFrame.current = targetRef.current;
      v.currentTime = videoTimeOf(targetRef.current);
    }
  }, [videoTimeOf]);

  useEffect(() => {
    let alive = true;
    const src = new FrameSource(url);
    sourceRef.current = src;
    src.onFrame = (f, canvas) => {
      if (alive && f === targetRef.current && modeRef.current === "exact") present(f, canvas);
    };
    src.onError = (e) => alive && fallBack(`decoder error: ${e instanceof Error ? e.message : String(e)}`);
    src
      .open()
      .then(() => {
        if (!alive) return;
        if (!clock.current.calibrated) clock.current.base = src.timestamps[0];
        setFrames(src.frameCount);
        if (src.width && src.height) setDims({ width: src.width, height: src.height });
        modeRef.current = "exact";
        setMode("exact");
        if (playingRef.current) return;
        const c = src.get(targetRef.current);
        if (c) present(targetRef.current, c);
        src.request(targetRef.current);
      })
      .catch((e) => alive && fallBack(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      src.dispose();
      if (sourceRef.current === src) sourceRef.current = null;
    };
  }, [url, present, fallBack]);

  const seek = useCallback(
    (f: number) => {
      f = Math.max(0, Math.min(framesRef.current - 1, Math.round(f)));
      const v = videoRef.current;
      if (playingRef.current) {
        seekAfterPause.current = f;
        v?.pause();
        return;
      }
      targetRef.current = f;
      setTarget(f);
      const src = sourceRef.current;
      if (modeRef.current === "exact" && src) {
        const c = src.get(f);
        if (c) present(f, c);
        src.request(f);
      } else if (v && v.readyState >= 1 && clock.current.ready) {
        videoSeekFrame.current = f;
        v.currentTime = videoTimeOf(f);
      }
    },
    [present, videoTimeOf],
  );

  const step = useCallback((d: number) => seek((playingRef.current ? lastPresented.current : targetRef.current) + d), [seek]);

  const play = useCallback(() => {
    const v = videoRef.current;
    if (!v || v.readyState < 2 || !clock.current.ready) return;
    const r = rangeRef.current;
    let start = targetRef.current;
    if (r && (start < r.a || start >= r.b)) start = r.a;
    else if (!r && start >= framesRef.current - 1) start = 0;
    v.currentTime = videoTimeOf(start);
    v.playbackRate = rate;
    void v.play().catch(() => {});
  }, [videoTimeOf, rate]);

  const togglePlay = useCallback(() => {
    if (playingRef.current) videoRef.current?.pause();
    else play();
  }, [play]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  // Playback: follow the presented frame exactly via requestVideoFrameCallback.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playing) return;
    let alive = true;
    let handle = 0;
    const rvfc = "requestVideoFrameCallback" in v;
    const schedule = () => {
      handle = rvfc ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(() => tick(0));
    };
    const tick = (_now: number, md?: VideoFrameCallbackMetadata) => {
      if (!alive) return;
      const f = frameOfMediaTime(md ? md.mediaTime : v.currentTime);
      const r = rangeRef.current;
      const end = r ? r.b : framesRef.current - 1;
      const start = r ? r.a : 0;
      if (f > end || (r && f < start)) {
        if (loopRef.current) v.currentTime = videoTimeOf(start);
        else {
          seekAfterPause.current = end;
          v.pause();
          return;
        }
        schedule();
        return;
      }
      if (modeRef.current === "exact") showFrameCanvas(false);
      lastPresented.current = f;
      targetRef.current = f;
      flushSync(() => {
        setFrame(f);
        setTarget(f);
      });
      if (f === end && r && !loopRef.current) {
        seekAfterPause.current = end;
        v.pause();
        return;
      }
      schedule();
    };
    schedule();
    return () => {
      alive = false;
      if (rvfc) v.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
    };
  }, [playing, frameOfMediaTime, videoTimeOf]);

  const onPause = () => {
    playingRef.current = false;
    setPlaying(false);
    const f = seekAfterPause.current ?? lastPresented.current;
    seekAfterPause.current = null;
    seek(f);
  };

  const onLoadedData = () => {
    setVideoReady(true);
    const v = videoRef.current;
    if (!v || clock.current.ready) return;
    if ("requestVideoFrameCallback" in v) void calibrate(v);
    else finishClock(null);
  };

  /**
   * Learn where this browser puts frame 0 on the element timeline (engines treat MP4 edit
   * lists differently: Chrome and WebKit present these files' first frame at 0.04 s).
   * Seeking to 0 always presents frame 0, but WebKit skips the frame callback when the
   * element is already there, so step away first. Element seeks wait until this is done.
   */
  const calibrate = async (v: HTMLVideoElement) => {
    const presented = () =>
      new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 2000);
        v.requestVideoFrameCallback((_n, md) => {
          clearTimeout(timer);
          resolve(md.mediaTime);
        });
      });
    let next = presented();
    v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
    const mid = await next;
    if (mid === null) return finishClock(null);
    next = presented();
    v.currentTime = 0;
    const first = await next;
    if (first !== null) return finishClock(first);
    // WebKit presents nothing for times before the first frame (a leading empty edit). The
    // edit's length is what the duration has beyond the frames; snap it to `mid`'s frame grid.
    const est = Math.max(0, v.duration - framesRef.current / fps);
    finishClock(Math.max(0, mid - Math.round((mid - est) * fps) / fps));
  };

  /** Clock known (or given up on): element seeks may proceed; show the wanted frame. */
  const finishClock = (base: number | null) => {
    if (clock.current.ready) return;
    if (base !== null) {
      clock.current.base = base;
      clock.current.calibrated = true;
    }
    clock.current.ready = true;
    setClockReady(true);
    if (modeRef.current !== "exact" && !playingRef.current) seek(targetRef.current);
  };


  const onSeeked = () => {
    const v = videoRef.current;
    if (!v || videoSeekFrame.current === null || playingRef.current || modeRef.current === "exact") return;
    // Trust where the element actually is, not which request was last issued: a seek that
    // lands while a newer one is pending must not label the picture with the newer frame.
    const f = frameOfMediaTime(v.currentTime);
    if (f !== targetRef.current) return;
    videoSeekFrame.current = null;
    lastPresented.current = f;
    // No requestVideoFrameCallback cross-check here: WebKit can deliver the previous frame's
    // metadata after a paused seek, which would relabel a correct picture.
    flushSync(() => setFrame(f));
  };


  // ---------------------------------------------------------------- camera
  const { containerRef, canvasRef, size } = useCanvasSize();
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const stageRef = useCallback(
    (el: HTMLDivElement | null) => {
      setStageEl(el);
      containerRef(el);
    },
    [containerRef],
  );
  const vp = useViewport2D(dims, size, 1);
  const { camera, toScreen, toContent } = vp;
  const zoomAtRef = useRef(vp.zoomAt);
  zoomAtRef.current = vp.zoomAt;

  useEffect(() => {
    if (!stageEl) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = stageEl.getBoundingClientRect();
      zoomAtRef.current(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    };
    stageEl.addEventListener("wheel", onWheel, { passive: false });
    return () => stageEl.removeEventListener("wheel", onWheel);
  }, [stageEl]);

  // ---------------------------------------------------------------- annotations on this frame
  const mine = useMemo(() => annotations.filter((a) => a.itemId === item.id), [annotations, item.id]);
  const visible = useMemo(() => visibleFor(annotations, item.id, hiddenLabels), [annotations, item.id, hiddenLabels]);
  const numbers = useMemo(() => trackNumbers(mine), [mine]);
  const editable = useCallback((a: Annotation) => isEditable(a, lockedLabels), [lockedLabels]);
  const action = useRef<Action | null>(null);
  const [polyDraft, setPolyDraft] = useState<Pt[] | null>(null);
  const cursorPt = useRef<Pt | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const space = useRef({ down: false, panned: false });

  const renderables = useMemo<Renderable[]>(
    () =>
      visible.flatMap((a) => {
        if (!isSpatial(a.geometry)) return [];
        const shape = shapeOnFrame(a.geometry, frame);
        if (!shape) return [];
        const n = numbers.get(a.id);
        return [{ a, shape, tag: n ? `#${n} ${a.label}` : a.label, editable: editable(a) }];
      }),
    [visible, frame, numbers, editable],
  );

  // Draw overlays synchronously after every render (the frame and overlays share a paint).
  useLayoutEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    const act = action.current;
    const list = act?.kind === "edit" && act.live ? renderables.map((r) => (r.a.id === act.id ? { ...r, shape: { ...r.shape, ...act.live } } : r)) : renderables;
    drawRenderables(ctx, list, toScreen, { labels, selectedId, selectedIds: selectedSet, opacity: overlayOpacity });
    const color = activeLabel ? resolveLabelColor(labels, activeLabel) : "#fff";
    if (act?.kind === "draw-box") drawDraft(ctx, color, { kind: "box", a: act.a, b: act.b }, toScreen);
    if (polyDraft) drawDraft(ctx, color, { kind: "polygon", points: polyDraft, cursor: cursorPt.current }, toScreen);
  });

  useEffect(() => {
    videoPlayhead.itemId = item.id;
    videoPlayhead.frame = frame;
  }, [frame, item.id]);
  useEffect(
    () => () => {
      videoPlayhead.itemId = null;
    },
    [],
  );

  // ---------------------------------------------------------------- creating & editing
  const labelUsable = (l: string | null): l is string => !!l && !lockedLabels.includes(l);

  const create = (kind: "box" | "polygon" | "keypoint", data: ShapeData) => {
    if (!labelUsable(activeLabel)) return;
    const f = frameRef.current;
    const r = (p: Pt) => [round2(p[0]), round2(p[1])] as Pt;
    let geometry: Geometry;
    let attributes: Annotation["attributes"];
    if (perFrame) {
      if (kind === "box") {
        const [x, y, w, h] = data.box!;
        geometry = { type: "box", x: round2(x), y: round2(y), w: round2(w), h: round2(h), frame: f };
      } else if (kind === "polygon") geometry = { type: "polygon", points: data.points!.map(r), frame: f };
      else geometry = { type: "keypoint", x: round2(data.points![0][0]), y: round2(data.points![0][1]), frame: f };
    } else {
      geometry = {
        type: "track",
        shape: kind,
        keyframes: [{ frame: f, ...(data.box ? { box: data.box.map(round2) as Box } : { points: data.points!.map(r) }) }],
      };
      attributes = { trackId: nextTrackId(useStudio.getState().annotations, item.id) };
    }
    const a = newAnnotation({ itemId: item.id, label: activeLabel, geometry, attributes });
    add(a);
    select(a.id);
  };

  const commitShape = (id: string, data: ShapeData) => {
    const a = useStudio.getState().annotations.find((x) => x.id === id);
    if (!a || !editable(a)) return;
    update(id, { geometry: applyShape(a.geometry, frameRef.current, data) });
  };

  const polyRef = useRef(polyDraft);
  polyRef.current = polyDraft;
  const closePolygon = (pts = polyRef.current) => {
    setPolyDraft(null);
    if (pts && pts.length >= 3) create("polygon", { points: pts });
  };

  const addEvent = () => {
    if (!labelUsable(activeLabel)) return;
    const a = newAnnotation({ itemId: item.id, label: activeLabel, geometry: { type: "event", frame: frameRef.current } });
    add(a);
    select(a.id);
  };

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const clampPt = ([x, y]: Pt): Pt => [Math.max(0, Math.min(dims.width, x)), Math.max(0, Math.min(dims.height, y))];

  const ready = mode === "exact" || (videoReady && clockReady);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const sp = local(e);
    const cp = toContent(...sp);
    if (e.button === 1 || (e.button === 0 && (tool === "pan" || space.current.down))) {
      e.preventDefault();
      if (space.current.down) space.current.panned = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      vp.startPan(e);
      action.current = { kind: "pan" };
      return;
    }
    if (e.button !== 0 || !ready) return;
    if (playingRef.current) videoRef.current?.pause();

    const hit = hitTest(renderables, sp, toScreen, selectedId);
    const drawing = tool === "box" || tool === "polygon" || tool === "keypoint";
    // Shift/⌘/Ctrl-click adds to or removes from the selection.
    if ((e.shiftKey || e.metaKey || e.ctrlKey) && hit && !polyDraft) {
      toggleSelect(hit.id);
      return;
    }
    // Shape tools still edit the selected shape's handles; everything else selects/edits.
    const editHit = hit && (!drawing || (hit.id === selectedId && !polyDraft)) ? hit : null;

    if (drawing && !editHit) {
      if (!labelUsable(activeLabel)) return;
      if (tool === "box") {
        e.currentTarget.setPointerCapture(e.pointerId);
        action.current = { kind: "draw-box", a: clampPt(cp), b: clampPt(cp) };
      } else if (tool === "keypoint") {
        create("keypoint", { points: [clampPt(cp)] });
      } else {
        const pts = polyDraft ?? [];
        if (pts.length >= 3) {
          const [fx, fy] = toScreen(...pts[0]);
          if (Math.hypot(fx - sp[0], fy - sp[1]) <= CLOSE_RADIUS) return closePolygon(pts);
        }
        setPolyDraft([...pts, clampPt(cp)]);
      }
      return;
    }
    if (tool === "event" && !hit) return addEvent();
    if (!editHit) {
      select(null);
      return;
    }
    select(editHit.id);
    const r = renderables.find((x) => x.a.id === editHit.id)!;
    if (!r.editable) return;
    const s = r.shape;
    if (s.kind === "polygon" && editHit.part === "vertex" && e.altKey) {
      if (s.points!.length > 3) commitShape(r.a.id, { points: s.points!.filter((_, i) => i !== editHit.index) });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (s.kind === "polygon" && editHit.part === "edge") {
      const pts = [...s.points!];
      pts.splice(editHit.index, 0, cp);
      action.current = { kind: "edit", id: r.a.id, part: "vertex", index: editHit.index, start: cp, orig: { ...s, points: pts }, live: { points: pts } };
    } else {
      action.current = { kind: "edit", id: r.a.id, part: editHit.part, index: editHit.index, start: cp, orig: s, live: null };
    }
    bump();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const act = action.current;
    const sp = local(e);
    const cp = toContent(...sp);
    if (act?.kind === "pan") {
      vp.movePan(e);
      return;
    }
    if (act?.kind === "draw-box") {
      act.b = clampPt(cp);
      bump();
      return;
    }
    if (act?.kind === "edit") {
      const dx = cp[0] - act.start[0], dy = cp[1] - act.start[1];
      const o = act.orig;
      if (act.part === "handle" && o.box) act.live = { box: resizeBox(o.box, act.index, dx, dy) };
      else if (act.part === "vertex" && o.points) act.live = { points: o.points.map((p, i) => (i === act.index ? [p[0] + dx, p[1] + dy] : p)) };
      else act.live = translateShape(o, dx, dy);
      bump();
      return;
    }
    if (polyDraft) {
      cursorPt.current = clampPt(cp);
      bump();
    }
    // Hover cursor.
    const el = e.currentTarget;
    if (space.current.down || tool === "pan") el.style.cursor = "grab";
    else {
      const hit = hitTest(renderables, sp, toScreen, selectedId);
      const drawing = tool === "box" || tool === "polygon" || tool === "keypoint";
      if (hit && (!drawing || hit.id === selectedId)) {
        const r = renderables.find((x) => x.a.id === hit.id);
        el.style.cursor = !r?.editable ? "pointer" : hit.part === "handle" ? HANDLE_CURSORS[hit.index] : hit.part === "vertex" ? "move" : hit.part === "edge" ? "copy" : "move";
      } else el.style.cursor = drawing || tool === "event" ? "crosshair" : "default";
    }
  };

  const onPointerUp = () => {
    const act = action.current;
    action.current = null;
    if (!act) return;
    if (act.kind === "pan") vp.endPan();
    else if (act.kind === "draw-box") {
      const [x0, y0] = act.a, [x1, y1] = act.b;
      const box: Box = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
      if (box[2] > 3 && box[3] > 3) create("box", { box });
    } else if (act.kind === "edit" && act.live) commitShape(act.id, act.live);
    bump();
  };

  const onDoubleClick = () => {
    if (tool !== "polygon" || !polyRef.current) return;
    // The double-click's second press added a duplicate vertex; drop it, then close.
    const pts = polyRef.current;
    const dup = pts.length > 1 && Math.hypot(pts[pts.length - 1][0] - pts[pts.length - 2][0], pts[pts.length - 1][1] - pts[pts.length - 2][1]) * camera.scale < 4;
    closePolygon(dup ? pts.slice(0, -1) : pts);
  };

  useEffect(() => {
    if (tool !== "polygon") setPolyDraft(null);
  }, [tool]);

  // ---------------------------------------------------------------- tracks
  const selected = mine.find((a) => a.id === selectedId) ?? null;
  const selectedTrack = selected?.geometry.type === "track" ? (selected as Annotation & { geometry: TrackGeometry }) : null;

  /** Selected annotations of this item (primary last), as currently stored. */
  const selection = () => {
    const st = useStudio.getState();
    const ids = new Set(st.selectedIds.length ? st.selectedIds : st.selectedId ? [st.selectedId] : []);
    return st.annotations.filter((a) => ids.has(a.id) && a.itemId === item.id);
  };

  /** Apply a keyframe operation to every selected, editable track on the current frame (one undo step). */
  const editTrack = (fn: (g: TrackGeometry, f: number) => TrackGeometry) => {
    const tracks = selection().filter((a): a is Annotation & { geometry: TrackGeometry } => a.geometry.type === "track" && editable(a));
    if (!tracks.length) return false;
    const updates = tracks.flatMap((a) => {
      const g = fn(a.geometry, frameRef.current);
      return g !== a.geometry ? [{ id: a.id, patch: { geometry: g as Geometry } }] : [];
    });
    if (updates.length === 1) update(updates[0].id, updates[0].patch);
    else if (updates.length) batch({ update: updates });
    return true;
  };

  /** Previous / next keyframe of the selected track, or of anything on the timeline when nothing is selected. */
  const jumpKeyframe = (dir: -1 | 1) => {
    const cur = targetRef.current;
    const marks = selectedTrack
      ? selectedTrack.geometry.keyframes.map((k) => k.frame)
      : mine.flatMap((a) => {
          const g = a.geometry;
          if (g.type === "track") return g.keyframes.map((k) => k.frame);
          if (g.type === "event") return [g.frame];
          if (g.type === "segment") return [Math.round(g.start * fps)];
          const frame = (g as { frame?: number }).frame;
          return typeof frame === "number" ? [frame] : [];
        });
    const sorted = [...new Set(marks)].sort((a, b) => a - b);
    const next = dir > 0 ? sorted.find((f) => f > cur) : sorted.reverse().find((f) => f < cur);
    if (next !== undefined) seek(next);
  };

  /** Alt+B: copy every selected shape onto the next frame (a keyframe for tracks) and move there. One undo step. */
  const propagate = () => {
    const f = frameRef.current;
    if (f + 1 >= frames) return;
    const updates: { id: string; patch: { geometry: Geometry } }[] = [];
    const copies: Annotation[] = [];
    for (const a of selection()) {
      const g = a.geometry;
      if (!editable(a)) continue;
      if (g.type === "track") {
        const shape = shapeAt(g, f);
        if (shape) updates.push({ id: a.id, patch: { geometry: applyShape(g, f + 1, { box: shape.box, points: shape.points }) } });
      } else if ((g.type === "box" || g.type === "polygon" || g.type === "keypoint") && g.frame === f) {
        copies.push(newAnnotation({ itemId: item.id, label: a.label, geometry: { ...g, frame: f + 1 }, attributes: a.attributes }));
      }
    }
    if (!updates.length && !copies.length) return;
    if (updates.length + copies.length === 1 && updates.length) update(updates[0].id, updates[0].patch);
    else batch({ update: updates, upsert: copies });
    // Per-frame copies become the selection on the new frame; tracks stay selected.
    if (copies.length) useStudio.getState().selectMany([...updates.map((u) => u.id), ...copies.map((c) => c.id)]);
    seek(f + 1);
  };

  // ---------------------------------------------------------------- keyboard
  useHotkeys((e) => {
    if (e.key.startsWith("Arrow") && (e.target as HTMLElement).closest?.('[role="slider"],[role="tab"]')) return false;
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      // e.code: on macOS Option turns "," into "≤" etc.
      if (e.code === "Comma") return jumpKeyframe(-1), true;
      if (e.code === "Period") return jumpKeyframe(1), true;
      if (e.code === "KeyB") return propagate(), true;
      return false;
    }
    if (e.metaKey || e.ctrlKey) return false;
    switch (e.key) {
      case " ":
        if (!e.repeat && !space.current.down) space.current = { down: true, panned: false };
        return true;
      case ",":
      case "<":
        step(e.shiftKey ? -10 : -1);
        return true;
      case ".":
      case ">":
        step(e.shiftKey ? 10 : 1);
        return true;
      case "ArrowLeft":
        step(e.shiftKey ? -10 : -1);
        return true;
      case "ArrowRight":
        step(e.shiftKey ? 10 : 1);
        return true;
      case "Home":
        seek(range ? range.a : 0);
        return true;
      case "End":
        seek(range ? range.b : frames - 1);
        return true;
      case "Escape":
        if (polyDraft) return setPolyDraft(null), true;
        return false;
      case "Backspace":
        if (polyDraft) return setPolyDraft(polyDraft.length > 1 ? polyDraft.slice(0, -1) : null), true;
        return false;
      case "Enter":
        if (polyDraft) return closePolygon(), true;
        if (tool === "event") return addEvent(), true;
        return false;
    }
    const k = e.key.toLowerCase();
    if (k === "k" && e.shiftKey) return editTrack(toggleKeyframe), true;
    if (k === "o") return editTrack(e.shiftKey ? toggleOccluded : toggleOutside);
    if (k === "l" && !e.shiftKey) return setLoop((l) => !l), true;
    if (k === "f" && !e.shiftKey) return vp.fit(), true;
    return false;
  });

  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.key !== " " || !space.current.down) return;
      const panned = space.current.panned;
      space.current = { down: false, panned: false };
      if (!panned) togglePlay();
    };
    const blur = () => (space.current = { down: false, panned: false });
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [togglePlay]);

  // ---------------------------------------------------------------- status
  const decodeLabel = mode === "exact" ? "exact frames (WebCodecs)" : mode === "loading" ? "indexing frames…" : `video seek (${fallbackReason ?? "fallback"})`;
  useEffect(() => {
    setViewerStatus(
      `Frame ${target + 1}/${frames} · ${formatTime(target / fps)} / ${formatTime(frames / fps)} · ${fps} fps · ${dims.width}×${dims.height}px · ${Math.round(camera.scale * 100)}% · ${decodeLabel}`,
    );
  }, [target, frames, fps, dims.width, dims.height, camera.scale, decodeLabel, setViewerStatus]);

  // ---------------------------------------------------------------- filmstrip
  const filmstrip = useMemo<FilmstripSource | null>(() => {
    const src = sourceRef.current;
    if (mode !== "exact" || !src) return null;
    return {
      get: (f) => src.getThumb(f) as CanvasImageSource | undefined,
      load: (list) => void src.loadThumbs(list, 96, () => setThumbVersion((v) => v + 1)),
      aspect: dims.width / Math.max(1, dims.height),
      version: thumbVersion,
    };
  }, [mode, dims.width, dims.height, thumbVersion]);

  // ---------------------------------------------------------------- render
  const filter = `brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturation}%)`;
  const mediaStyle: React.CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: dims.width,
    height: dims.height,
    transformOrigin: "0 0",
    transform: `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.scale})`,
    filter,
    imageRendering: camera.scale >= 3 ? "pixelated" : "auto",
  };
  const kfHere = selectedTrack ? keyframeAt(selectedTrack.geometry, frame) : undefined;
  const selShape = selectedTrack ? shapeAt(selectedTrack.geometry, frame) : null;
  const selKfs = selectedTrack ? sortKeyframes(selectedTrack.geometry.keyframes) : [];
  const trackEditable = !!selectedTrack && editable(selectedTrack);

  return (
    <div className="flex h-full flex-col bg-canvas text-canvas-foreground">
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden" data-testid="video-stage" data-decode-mode={mode} data-clock={clockReady ? "ready" : "pending"} data-frame={frame} data-camera={`${camera.scale} ${camera.tx} ${camera.ty}`}>
        <video
          ref={videoRef}
          data-testid="video-element"
          src={url}
          style={{ ...mediaStyle, objectFit: "fill" }}
          preload="auto"
          muted
          playsInline
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (!dims.width && v.videoWidth) setDims({ width: v.videoWidth, height: v.videoHeight });
            if (modeRef.current !== "exact" && !asset.frames && v.duration) setFrames(Math.max(1, Math.round(v.duration * fps)));
          }}
          onLoadedData={onLoadedData}
          onPlay={() => {
            playingRef.current = true;
            setPlaying(true);
            setPolyDraft(null);
          }}
          onPause={onPause}
          onEnded={() => {
            if (loopRef.current && !rangeRef.current) queueMicrotask(play);
          }}
          onSeeked={onSeeked}
          onError={() => setError(mode === "exact" ? "Playback is unavailable for this file; frame stepping still works." : "This video could not be played.")}
        />
        <canvas ref={frameCanvasRef} style={{ ...mediaStyle, visibility: "hidden" }} aria-hidden data-testid="video-frame" />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none"
          style={{ width: size.width, height: size.height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={onDoubleClick}
          onAuxClick={(e) => e.preventDefault()}
          data-testid="video-overlay"
        />
        {!ready && !error && <CanvasNotice>Loading video…</CanvasNotice>}
        {error && <CanvasNotice>{error}</CanvasNotice>}

        {/* Top-left: drawing mode + decode state */}
        <div className="absolute left-2 top-2 flex items-center gap-1.5 text-xs">
          <div className="flex rounded-md bg-black/55 p-0.5 backdrop-blur" role="radiogroup" aria-label="Drawing mode">
            {([
              [false, "Track", "Shapes become object tracks with keyframes; frames in between are interpolated"],
              [true, "Per-frame", "Shapes exist on one frame only (Alt+B copies to the next frame)"],
            ] as const).map(([v, label, hint]) => (
              <Tooltip key={label}>
                <TooltipTrigger asChild>
                  <button
                    role="radio"
                    aria-checked={perFrame === v}
                    onClick={() => {
                      perFrameDefault = v;
                      setPerFrame(v);
                    }}
                    className={cn("rounded px-2 py-0.5 transition-colors", perFrame === v ? "bg-white/20 text-white" : "text-white/65 hover:text-white")}
                  >
                    {label}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{hint}</TooltipContent>
              </Tooltip>
            ))}
          </div>
          <span
            className={cn("rounded-md bg-black/55 px-2 py-1 backdrop-blur", mode === "exact" ? "text-white/75" : "text-amber-300")}
            title={mode === "video" ? `Frame-exact decoding unavailable (${fallbackReason}); stepping seeks the <video> element and may land ±1 frame on some files.` : undefined}
          >
            {mode === "exact" ? "Exact frames" : mode === "loading" ? "Indexing…" : "Approximate seek"}
          </span>
        </div>

        {/* Top-right: view controls */}
        <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-md bg-black/55 p-0.5 text-white backdrop-blur">
          <BarIconButton label="Zoom out" onClick={() => vp.zoomAt(1 / 1.25)} icon={ZoomOut} />
          <span className="tnum w-11 text-center text-xs text-white/80">{Math.round(camera.scale * 100)}%</span>
          <BarIconButton label="Zoom in" onClick={() => vp.zoomAt(1.25)} icon={ZoomIn} />
          <BarIconButton label="Fit" shortcut="F" onClick={vp.fit} icon={Scan} />
          <BarIconButton label="Actual size (1:1)" onClick={vp.actualSize} icon={SquareDashed} />
          <Popover>
            <PopoverTrigger asChild>
              <button aria-label="Image adjustments" title="Brightness, contrast, saturation" className={cn("flex h-7 w-7 items-center justify-center rounded hover:bg-white/15", (adjust.brightness !== 100 || adjust.contrast !== 100 || adjust.saturation !== 100) && "text-primary")}>
                <SlidersHorizontal className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 space-y-3 text-sm">
              {(["brightness", "contrast", "saturation"] as const).map((k) => (
                <label key={k} className="block">
                  <div className="mb-1 flex justify-between capitalize">
                    <span>{k}</span>
                    <span className="tnum text-muted-foreground">{adjust[k]}%</span>
                  </div>
                  <input type="range" min={0} max={300} step={5} value={adjust[k]} onChange={(e) => setAdjust((a) => ({ ...a, [k]: +e.target.value }))} className="w-full accent-[hsl(var(--primary))]" />
                </label>
              ))}
              <button className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setAdjust({ brightness: 100, contrast: 100, saturation: 100 })}>
                Reset
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="border-t border-white/10 px-2 pb-1.5 pt-1">
        <Timeline
          frames={frames}
          fps={fps}
          frame={target}
          labels={labels}
          annotations={visible}
          numbers={numbers}
          selectedId={selectedId}
          selectedIds={selectedIds}
          tool={tool}
          activeLabel={activeLabel}
          range={range}
          editable={editable}
          filmstrip={filmstrip}
          onSeek={seek}
          onRange={setRange}
          onSelect={select}
          onToggleSelect={toggleSelect}
          onCreateSegment={(label, start, end) => {
            if (!labelUsable(label)) return;
            const a = newAnnotation({ itemId: item.id, label, geometry: { type: "segment", start: +start.toFixed(4), end: +end.toFixed(4) } });
            add(a);
            select(a.id);
          }}
          onCreateEvent={(f) => {
            if (!labelUsable(activeLabel)) return;
            const a = newAnnotation({ itemId: item.id, label: activeLabel, geometry: { type: "event", frame: f } });
            add(a);
            select(a.id);
            seek(f);
          }}
          onGeometry={(id, g) => {
            const a = useStudio.getState().annotations.find((x) => x.id === id);
            if (a && editable(a)) update(id, { geometry: g });
          }}
        />

        <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1">
          <BarIconButton label="First frame" shortcut="Home" onClick={() => seek(range ? range.a : 0)} icon={SkipBack} />
          <BarIconButton label="Previous frame" shortcut=", or ←  (Shift: 10)" onClick={() => step(-1)} icon={StepBack} />
          <BarIconButton label={playing ? "Pause" : "Play"} shortcut="Space" onClick={togglePlay} icon={playing ? Pause : Play} primary disabled={!videoReady || !clockReady} />
          <BarIconButton label="Next frame" shortcut=". or →  (Shift: 10)" onClick={() => step(1)} icon={StepForward} />
          <BarIconButton label="Last frame" shortcut="End" onClick={() => seek(range ? range.b : frames - 1)} icon={SkipForward} />

          <span className="tnum ml-1 text-xs text-canvas-foreground/70">{formatTime(target / fps)}</span>
          <FrameInput frame={target} frames={frames} onSeek={seek} />

          <div className="mx-1 h-4 w-px bg-white/10" />
          <div className="flex items-center gap-0.5 text-xs">
            {RATES.map((r) => (
              <button
                key={r}
                onClick={() => setRate(r)}
                className={cn("tnum rounded-md px-1.5 py-0.5 transition-colors", r === rate ? "bg-white/15 text-canvas-foreground" : "text-canvas-foreground/60 hover:bg-white/10")}
              >
                {r}×
              </button>
            ))}
          </div>
          <BarIconButton label={loop ? "Loop on" : "Loop off"} shortcut="L" onClick={() => setLoop((l) => !l)} icon={Repeat} active={loop} />
          <div className="flex items-center gap-0.5 text-xs">
            <BarTextButton title="Set loop start (A) at the playhead · or Shift-drag the ruler" onClick={() => setRange((r) => ({ a: target, b: r && r.b > target ? r.b : frames - 1 }))} active={!!range}>
              A{range ? ` ${range.a + 1}` : ""}
            </BarTextButton>
            <BarTextButton title="Set loop end (B) at the playhead" onClick={() => setRange((r) => ({ a: r && r.a < target ? r.a : 0, b: target }))} active={!!range}>
              B{range ? ` ${range.b + 1}` : ""}
            </BarTextButton>
            {range && <BarIconButton label="Clear A–B range" onClick={() => setRange(null)} icon={X} />}
          </div>

          <div className="ml-auto flex items-center gap-0.5 text-xs">
            {selectedTrack ? (
              <>
                <span className="mr-1 text-canvas-foreground/70">
                  #{numbers.get(selectedTrack.id)} <span className="capitalize">{selectedTrack.label}</span> · {selKfs.length} keyframes
                </span>
                <BarIconButton label="Previous keyframe" shortcut="Alt+," onClick={() => jumpKeyframe(-1)} icon={ChevronLeft} />
                <BarIconButton label={kfHere ? "Remove keyframe" : "Add keyframe"} shortcut="Shift+K" onClick={() => editTrack(toggleKeyframe)} icon={Diamond} active={!!kfHere} disabled={!trackEditable} />
                <BarIconButton label="Next keyframe" shortcut="Alt+." onClick={() => jumpKeyframe(1)} icon={ChevronRight} />
                <BarIconButton label={selShape ? "Mark outside (hide from here)" : "Bring back in view"} shortcut="O" onClick={() => editTrack(toggleOutside)} icon={EyeOff} active={!selShape} disabled={!trackEditable} />
                <BarTextButton title="Toggle occluded (Shift+O)" onClick={() => editTrack(toggleOccluded)} active={!!selShape?.occluded} disabled={!trackEditable || !selShape}>
                  Occluded
                </BarTextButton>
                <BarIconButton label="Copy to next frame" shortcut="Alt+B" onClick={propagate} icon={Copy} disabled={!trackEditable || !selShape} />
              </>
            ) : selected && selected.geometry.type !== "segment" && selected.geometry.type !== "event" && isSpatial(selected.geometry) ? (
              <BarIconButton label="Copy to next frame" shortcut="Alt+B" onClick={propagate} icon={Copy} />
            ) : (
              <span className="text-canvas-foreground/45">{hint(tool, perFrame)}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function hint(tool: string, perFrame: boolean): string {
  switch (tool) {
    case "box":
    case "polygon":
    case "keypoint":
      return perFrame ? "Draws a shape on this frame only" : "Draws a new track · edit on later frames to add keyframes";
    case "segment":
      return "Drag in a label's lane to mark a span";
    case "event":
      return "Click the frame or press Enter to mark an event";
    default:
      return "Space play · ←/→ step · Shift-drag ruler for A–B";
  }
}

function FrameInput({ frame, frames, onSeek }: { frame: number; frames: number; onSeek: (f: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex items-center gap-1 text-xs text-canvas-foreground/70">
      frame
      <input
        aria-label="Jump to frame"
        inputMode="numeric"
        className="tnum h-6 w-14 rounded border border-white/15 bg-white/5 px-1 text-right text-canvas-foreground outline-none focus:border-primary"
        value={draft ?? String(frame + 1)}
        onFocus={(e) => {
          setDraft(String(frame + 1));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (draft) onSeek(+draft - 1);
            e.currentTarget.blur();
          } else if (e.key === "Escape") e.currentTarget.blur();
        }}
        onBlur={() => setDraft(null)}
      />
      <span className="tnum">/ {frames}</span>
    </label>
  );
}

