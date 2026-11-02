import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { labelNames } from "@studio/contracts/environment";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import { derivativeNotice, viewPath, type Annotation } from "@studio/contracts/types";
import { useViewport2D } from "@studio/renderers/overlay2d/useViewport2D";
import { CanvasNotice } from "@studio/renderers/viewport-chrome/CanvasNotice";
import { formatTime } from "@studio/renderers/viewport-chrome/format";
import { useCanvasSize } from "@studio/renderers/viewport-chrome/useCanvasSize";
import type { FilmstripSource } from "@studio/renderers/timeline/Timeline";
import { trackNumbers, type TrackGeometry } from "../tracks";
import { addInstant, copyToNextFrame, createShape, editable, editTracks, keyframeTarget, labelUsable, setGeometry } from "./actions";
import { FrameEditor, frameItems } from "./FrameEditor";
import { ModeBar, NO_ADJUST, ViewBar } from "./StageBars";
import { TransportBar } from "./TransportBar";
import { useVideoCommands } from "./useVideoCommands";
import { VideoEngine } from "./VideoEngine";
import { VideoTimeline } from "./VideoTimeline";
import { assetUrl, markFirstFrame, useHost, visibleFor } from "@studio/plugin-ui-sdk";
import { useRequestedPlacement } from "@studio/plugin-ui-sdk/runtime";

/** "Per-frame shape" drawing mode survives switching videos. */
let perFrameDefault = false;

/** Remount per item so decoder, clock and camera state never leak between videos. */
export function VideoRenderer(props: RendererProps) {
  // todo18 D4: an AVI/MOV/MKV plays from its MP4 once the worker converted it.
  const notice = derivativeNotice(props.item.assets[0] ?? {});
  if (notice) {
    return (
      <div className="relative h-full w-full" data-testid="video-derivative-notice">
        <CanvasNotice loading={notice.busy}>{notice.text}</CanvasNotice>
      </div>
    );
  }
  return <VideoHost key={props.item.id} {...props} />;
}

function VideoHost({ project, item, runtime }: RendererProps) {
  const asset = item.assets[0];
  const fps = asset.fps ?? 25;
  const url = assetUrl(viewPath(asset));
  const labels = useMemo(() => labelNames(project.labels), [project.labels]);

  const [engine] = useState(() => new VideoEngine({ url, fps, frames: asset.frames, duration: asset.duration, width: asset.width, height: asset.height }));
  const s = useSyncExternalStore(engine.subscribe, engine.getState);
  const { frame, target, frames, dims, mode } = s;
  useEffect(() => {
    if (engine.ready) markFirstFrame({ renderer: "frame-canvas", itemId: item.id });
  }, [engine.ready, item.id]);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [editor] = useState(() => new FrameEditor(bump));
  const [perFrame, setPerFrame] = useState(perFrameDefault);
  const [adjust, setAdjust] = useState(NO_ADJUST);

  const tool = useHost((st) => st.tool);
  const annotations = useHost((st) => st.annotations);
  const selectedId = useHost((st) => st.selectedId);
  const selectedIds = useHost((st) => st.selectedIds);
  const hiddenLabels = useHost((st) => st.hiddenLabels);
  const lockedLabels = useHost((st) => st.lockedLabels);
  const activeLabel = useHost((st) => st.activeLabel);
  const overlayOpacity = useHost((st) => st.overlayOpacity);
  const setViewerStatus = useHost((st) => st.setViewerStatus);

  const videoRef = useRef<HTMLVideoElement>(null);
  const frameCanvasRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => engine.attach(videoRef.current!, frameCanvasRef.current!), [engine]);

  // ---- camera
  const { containerRef, canvasRef, size } = useCanvasSize();
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const stageRef = useCallback((el: HTMLDivElement | null) => (setStageEl(el), containerRef(el)), [containerRef]);
  const vp = useViewport2D(dims, size, 1);
  const { camera } = vp;
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

  // ---- annotations on this frame
  const mine = useMemo(() => annotations.filter((a) => a.itemId === item.id), [annotations, item.id]);
  const visible = useMemo(() => visibleFor(annotations, item.id, hiddenLabels), [annotations, item.id, hiddenLabels]);
  const numbers = useMemo(() => trackNumbers(mine), [mine]);
  // lockedLabels: `editable` reads them from the store.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => frameItems(visible, frame, numbers, editable), [visible, frame, numbers, lockedLabels]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  editor.sync({
    tool, frame, dims, items, selectedId, selectedIds: selectedSet, labels, activeLabel, opacity: overlayOpacity,
    ready: engine.ready, playing: s.playing, scale: camera.scale, toScreen: vp.toScreen, toContent: vp.toContent,
    pan: { start: vp.startPan, move: vp.movePan, end: vp.endPan },
    canDraw: () => labelUsable(activeLabel),
    create: (kind, shape) => createShape(item.id, frame, perFrame, kind, shape),
    commit: setGeometry,
    addEvent: () => addInstant(item.id, frame),
    pause: engine.pause,
    select: (id) => useHost.getState().select(id),
    toggleSelect: (id) => useHost.getState().toggleSelect(id),
  });

  // Draw overlays synchronously after every render (the frame and overlays share a paint).
  useLayoutEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    editor.draw(ctx);
  });
  useEffect(() => {
    if (s.playing) editor.cancelDraft();
  }, [s.playing, editor]);

  // ---- runtime + status
  // Resume (and other shell navigation) opens on a frame once the decoder can seek.
  useRequestedPlacement(item.id, engine.ready, (p) => p.frame !== undefined && engine.seek(p.frame));
  useEffect(() => runtime.publish("playhead", { frame, time: frame / fps }), [runtime, frame, fps]);
  useEffect(() => () => runtime.publish("playhead", undefined), [runtime]);
  const decodeLabel = mode === "exact" ? "exact frames (WebCodecs)" : mode === "loading" ? "indexing frames…" : `video seek (${s.fallbackReason ?? "fallback"})`;
  useEffect(() => {
    setViewerStatus(`Frame ${target + 1}/${frames} · ${formatTime(target / fps)} / ${formatTime(frames / fps)} · ${fps} fps · ${dims.width}×${dims.height}px · ${Math.round(camera.scale * 100)}% · ${decodeLabel}`);
  }, [target, frames, fps, dims.width, dims.height, camera.scale, decodeLabel, setViewerStatus]);

  // ---- tracks + keys
  const selected = mine.find((a) => a.id === selectedId) ?? null;
  const selectedTrack = selected?.geometry.type === "track" ? (selected as Annotation & { geometry: TrackGeometry }) : null;
  const ops = {
    editTracks: (fn: (g: TrackGeometry, f: number) => TrackGeometry) => editTracks(item.id, frame, fn),
    jumpKeyframe: (dir: -1 | 1) => {
      const f = keyframeTarget(mine, selectedTrack?.geometry ?? null, fps, engine.getState().target, dir);
      if (f !== undefined) engine.seek(f);
    },
    copyToNext: () => {
      const f = copyToNextFrame(item.id, frame, frames);
      if (f !== null) engine.seek(f);
    },
  };
  useVideoCommands({ engine, editor, fit: vp.fit, addEvent: () => addInstant(item.id, frame), ...ops });

  const filmstrip = useMemo<FilmstripSource | null>(
    () => (mode === "exact" ? { get: engine.thumb, load: engine.loadThumbs, aspect: dims.width / Math.max(1, dims.height), version: s.thumbVersion } : null),
    [engine, mode, dims.width, dims.height, s.thumbVersion],
  );

  // ---- render
  const mediaStyle: React.CSSProperties = {
    position: "absolute", left: 0, top: 0, width: dims.width, height: dims.height, transformOrigin: "0 0",
    transform: `translate(${camera.tx}px, ${camera.ty}px) scale(${camera.scale})`,
    filter: `brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturation}%)`,
    imageRendering: camera.scale >= 3 ? "pixelated" : "auto",
  };

  return (
    <div className="flex h-full flex-col bg-canvas text-canvas-foreground">
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden" data-testid="video-stage" data-decode-mode={mode} data-clock={s.clockReady ? "ready" : "pending"} data-frame={frame} data-camera={`${camera.scale} ${camera.tx} ${camera.ty}`}>
        <video ref={videoRef} data-testid="video-element" src={url} style={{ ...mediaStyle, objectFit: "fill" }} preload="auto" muted playsInline />
        <canvas ref={frameCanvasRef} style={{ ...mediaStyle, visibility: "hidden" }} aria-hidden data-testid="video-frame" />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none"
          style={{ width: size.width, height: size.height }}
          onPointerDown={editor.onPointerDown}
          onPointerMove={editor.onPointerMove}
          onPointerUp={editor.onPointerUp}
          onPointerCancel={editor.onPointerUp}
          onDoubleClick={editor.onDoubleClick}
          onAuxClick={(e) => e.preventDefault()}
          data-testid="video-overlay"
        />
        {!engine.ready && !s.error && <CanvasNotice loading>Loading video</CanvasNotice>}
        {s.error && <CanvasNotice>{s.error}</CanvasNotice>}
        <ModeBar perFrame={perFrame} onPerFrame={(v) => setPerFrame((perFrameDefault = v))} mode={mode} fallbackReason={s.fallbackReason} />
        <ViewBar scale={camera.scale} zoomBy={(f) => vp.zoomAt(f)} fit={vp.fit} actualSize={vp.actualSize} adjust={adjust} onAdjust={setAdjust} />
      </div>

      <div className="border-t border-white/10 px-2 pb-1.5 pt-1">
        <VideoTimeline itemId={item.id} frames={frames} fps={fps} frame={target} labels={labels} visible={visible} numbers={numbers} range={s.range} filmstrip={filmstrip} onSeek={engine.seek} onRange={engine.setRange} />
        <TransportBar
          engine={engine}
          state={s}
          frame={frame}
          selected={selected}
          trackNumber={selectedTrack ? numbers.get(selectedTrack.id) : undefined}
          trackEditable={!!selectedTrack && editable(selectedTrack)}
          tool={tool}
          perFrame={perFrame}
          {...ops}
        />
      </div>
    </div>
  );
}
