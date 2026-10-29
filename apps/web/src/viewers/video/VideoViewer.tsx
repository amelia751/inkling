import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { seedUrl } from "@/lib/api";
import { resolveLabelColor, resolveToken } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { newAnnotation, useStudio } from "@/stores/studio";
import { formatTime } from "@/viewers/draw";
import { CanvasNotice } from "@/viewers/image2d/Image2DViewer";
import { useCanvasSize } from "@/viewers/useCanvasSize";
import type { ViewerProps } from "@/viewers/ViewerAdapter";

const RATES = [0.25, 0.5, 1, 2];

export function VideoViewer({ project, item }: ViewerProps) {
  const asset = item.assets[0];
  const fps = asset.fps ?? 25;
  const videoRef = useRef<HTMLVideoElement>(null);
  const { containerRef, canvasRef, size } = useCanvasSize();
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(asset.duration ?? 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [, redraw] = useState(0);

  const tool = useStudio((s) => s.tool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const annotations = useStudio((s) => s.annotations);
  const add = useStudio((s) => s.add);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);
  const labels = project.labels ?? [];

  const totalFrames = asset.frames ?? Math.round(duration * fps);
  // Small epsilon so a seek to a frame's start isn't read back as the previous frame.
  const frame = Math.min(totalFrames - 1, Math.floor(time * fps + 1e-3));
  const mine = annotations.filter((a) => a.itemId === item.id);

  useEffect(() => {
    setReady(false);
    setError(null);
    setTime(0);
    setPlaying(false);
  }, [item.id]);

  // Track the displayed frame precisely while playing.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playing) return;
    let handle = 0;
    const hasRvfc = "requestVideoFrameCallback" in v;
    const tick = () => {
      setTime(v.currentTime);
      handle = hasRvfc ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    tick();
    return () => (hasRvfc ? v.cancelVideoFrameCallback(handle) : cancelAnimationFrame(handle));
  }, [playing]);

  const seekFrame = useCallback(
    (f: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      const clamped = Math.max(0, Math.min(totalFrames - 1, f));
      // Land just inside the frame so the decoder doesn't present its predecessor.
      v.currentTime = clamped / fps + 0.001;
      setTime(v.currentTime);
    },
    [fps, totalFrames],
  );

  // Relative to the element's own clock, so rapid repeats don't read stale state.
  const step = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (v) seekFrame(Math.floor(v.currentTime * fps + 1e-3) + delta);
    },
    [fps, seekFrame],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === ",") step(-1);
      else if (e.key === ".") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, togglePlay]);

  useEffect(() => {
    setViewerStatus(`Frame ${frame + 1}/${totalFrames} · ${formatTime(time)} / ${formatTime(duration)} · ${fps} fps · ${asset.width}×${asset.height}px`);
  }, [frame, totalFrames, time, duration, fps, asset.width, asset.height, setViewerStatus]);

  // Where the video's pixels land inside the letterboxed element.
  const vw = asset.width ?? 1;
  const vh = asset.height ?? 1;
  const scale = Math.min(size.width / vw, size.height / vh);
  const ox = (size.width - vw * scale) / 2;
  const oy = (size.height - vh * scale) / 2;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    for (const a of mine) {
      if (a.geometry.type !== "box" || a.geometry.frame !== frame) continue;
      const { x, y, w, h } = a.geometry;
      const ai = a.provenance === "ai-suggested";
      ctx.strokeStyle = ai ? resolveToken("--prov-ai") : resolveLabelColor(labels, a.label);
      ctx.fillStyle = resolveLabelColor(labels, a.label, 0.12);
      ctx.lineWidth = 2;
      ctx.setLineDash(ai ? [6, 4] : []);
      ctx.fillRect(ox + x * scale, oy + y * scale, w * scale, h * scale);
      ctx.strokeRect(ox + x * scale, oy + y * scale, w * scale, h * scale);
      ctx.setLineDash([]);
      ctx.font = "12px Inter, sans-serif";
      const tw = ctx.measureText(a.label).width + 8;
      ctx.fillStyle = resolveLabelColor(labels, a.label, 0.9);
      ctx.fillRect(ox + x * scale, oy + y * scale - 16, tw, 16);
      ctx.fillStyle = "#fff";
      ctx.fillText(a.label, ox + x * scale + 4, oy + y * scale - 4);
    }
    const d = draft.current;
    if (d && activeLabel) {
      ctx.strokeStyle = resolveLabelColor(labels, activeLabel);
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
  });

  const local = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool !== "box" || !activeLabel) return;
    videoRef.current?.pause();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = local(e);
    draft.current = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draft.current) return;
    const p = local(e);
    draft.current.x1 = p.x;
    draft.current.y1 = p.y;
    redraw((n) => n + 1);
  };
  const onPointerUp = () => {
    const d = draft.current;
    draft.current = null;
    if (!d || !activeLabel) return;
    const toVid = (sx: number, sy: number) => [Math.max(0, Math.min(vw, (sx - ox) / scale)), Math.max(0, Math.min(vh, (sy - oy) / scale))];
    const [x0, y0] = toVid(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1));
    const [x1, y1] = toVid(Math.max(d.x0, d.x1), Math.max(d.y0, d.y1));
    if (x1 - x0 > 3 && y1 - y0 > 3) {
      add(newAnnotation({ itemId: item.id, label: activeLabel, geometry: { type: "box", x: x0, y: y0, w: x1 - x0, h: y1 - y0, frame } }));
    } else {
      redraw((n) => n + 1);
    }
  };

  return (
    <div className="flex h-full flex-col bg-canvas text-canvas-foreground">
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <video
          ref={videoRef}
          src={seedUrl(asset.path)}
          className="absolute inset-0 h-full w-full object-contain"
          preload="auto"
          muted
          playsInline
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration);
            setReady(true);
          }}
          onPlay={() => setPlaying(true)}
          onPause={(e) => {
            setPlaying(false);
            setTime(e.currentTarget.currentTime);
          }}
          onSeeked={(e) => setTime(e.currentTarget.currentTime)}
          onError={() => setError("This video could not be played.")}
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0"
          style={{ width: size.width, height: size.height, cursor: tool === "box" ? "crosshair" : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          data-testid="video-overlay"
        />
        {!ready && !error && <CanvasNotice>Loading video…</CanvasNotice>}
        {error && <CanvasNotice>{error}</CanvasNotice>}
      </div>

      <div className="border-t border-white/10 px-3 pb-2 pt-1.5">
        <Timeline
          duration={duration}
          time={time}
          labels={labels}
          segments={mine.flatMap((a) => (a.geometry.type === "segment" ? [{ id: a.id, label: a.label, ...a.geometry }] : []))}
          frameMarks={mine.flatMap((a) => (a.geometry.type === "box" && a.geometry.frame !== undefined ? [a.geometry.frame / fps] : []))}
          segmentMode={tool === "segment" && !!activeLabel}
          onSeek={(t) => seekFrame(Math.floor(t * fps))}
          onSegment={(start, end) =>
            activeLabel && add(newAnnotation({ itemId: item.id, label: activeLabel, geometry: { type: "segment", start: +start.toFixed(3), end: +end.toFixed(3) } }))
          }
        />
        <div className="mt-1.5 flex items-center gap-1">
          <TransportButton label="First frame" onClick={() => seekFrame(0)} icon={SkipBack} />
          <TransportButton label="Previous frame" shortcut="," onClick={() => step(-1)} icon={StepBack} />
          <TransportButton label={playing ? "Pause" : "Play"} shortcut="Space" onClick={togglePlay} icon={playing ? Pause : Play} primary />
          <TransportButton label="Next frame" shortcut="." onClick={() => step(1)} icon={StepForward} />
          <TransportButton label="Last frame" onClick={() => seekFrame(totalFrames - 1)} icon={SkipForward} />
          <span className="tnum ml-2 text-xs text-canvas-foreground/70">
            {formatTime(time)} · frame {frame + 1}/{totalFrames}
          </span>
          <div className="ml-auto flex items-center gap-0.5 text-xs">
            {RATES.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setRate(r);
                  if (videoRef.current) videoRef.current.playbackRate = r;
                }}
                className={cn("tnum rounded-md px-1.5 py-0.5 transition-colors", r === rate ? "bg-white/15 text-canvas-foreground" : "text-canvas-foreground/60 hover:bg-white/10")}
              >
                {r}×
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TransportButton({ label, shortcut, onClick, icon: Icon, primary }: { label: string; shortcut?: string; onClick: () => void; icon: typeof Play; primary?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={label}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
            primary ? "bg-primary text-primary-foreground hover:bg-primary-hover" : "text-canvas-foreground/80 hover:bg-white/10",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <kbd className="ml-1 font-mono opacity-70">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

interface TimelineProps {
  duration: number;
  time: number;
  labels: string[];
  segments: { id: string; label: string; start: number; end: number }[];
  /** Times of frames that carry box annotations. */
  frameMarks: number[];
  segmentMode: boolean;
  onSeek: (t: number) => void;
  onSegment: (start: number, end: number) => void;
}

/** Scrub bar with labeled spans; in segment mode a drag creates a new span. */
function Timeline({ duration, time, labels, segments, frameMarks, segmentMode, onSeek, onSegment }: TimelineProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ t0: number; t1: number } | null>(null);
  const pct = (t: number) => `${(duration ? t / duration : 0) * 100}%`;
  const at = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
  };

  return (
    <div
      ref={ref}
      className={cn("relative h-8 select-none rounded-md bg-white/5", segmentMode ? "cursor-col-resize" : "cursor-pointer")}
      data-testid="timeline"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const t = at(e.clientX);
        if (segmentMode) setDrag({ t0: t, t1: t });
        else onSeek(t);
      }}
      onPointerMove={(e) => {
        if (e.buttons !== 1) return;
        const t = at(e.clientX);
        if (drag) setDrag({ ...drag, t1: t });
        else if (!segmentMode) onSeek(t);
      }}
      onPointerUp={() => {
        if (drag && Math.abs(drag.t1 - drag.t0) > 0.05) onSegment(Math.min(drag.t0, drag.t1), Math.max(drag.t0, drag.t1));
        setDrag(null);
      }}
    >
      {segments.map((s) => (
        <div
          key={s.id}
          className="absolute bottom-1 top-1 flex items-center overflow-hidden rounded-sm px-1 text-[10px] capitalize text-white"
          style={{ left: pct(s.start), width: pct(s.end - s.start), background: resolveLabelColor(labels, s.label, 0.55) }}
          title={`${s.label} · ${formatTime(s.start)}–${formatTime(s.end)}`}
        >
          <span className="truncate">{s.label}</span>
        </div>
      ))}
      {frameMarks.map((t, i) => (
        <div key={i} className="absolute top-0 h-1.5 w-0.5 -translate-x-1/2 rounded-full bg-canvas-foreground/80" style={{ left: pct(t) }} />
      ))}
      {drag && (
        <div className="absolute bottom-1 top-1 rounded-sm border border-white/60 bg-white/20" style={{ left: pct(Math.min(drag.t0, drag.t1)), width: pct(Math.abs(drag.t1 - drag.t0)) }} />
      )}
      <div className="pointer-events-none absolute bottom-0 top-0 w-0.5 -translate-x-1/2 bg-primary" style={{ left: pct(time) }} />
    </div>
  );
}
