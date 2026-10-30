import { useEffect, useRef, type ReactNode } from "react";
import { LoopIcon, LoopOnceIcon, PauseIcon, PlayIcon } from "@studio/studio-ui/icons";
import { Slider } from "@studio/studio-ui/ui/slider";
import { cn } from "@studio/studio-ui/utils";
import { ToolbarButton, ToolbarSep } from "./controls";

/**
 * Frame transport for any frame-indexed data (cine, video, time-lapse): play / pause, a
 * frame slider with marker dots, an optional second axis (slices), fps, loop / bounce and
 * an A–B play range with named range presets. Domain-neutral: markers, aria labels and
 * presets come in as props.
 */

export type PlayMode = "loop" | "bounce";
export type FrameRange = [number | null, number | null];

export interface TransportProps {
  playing: boolean;
  onPlay: () => void;
  fps: number;
  setFps: (n: number) => void;
  mode: PlayMode;
  setMode: (m: PlayMode) => void;
  frame: number;
  setFrame: (f: number) => void;
  frames: number;
  /** Accessible name of the frame slider. */
  frameLabel?: string;
  /** Second axis (e.g. slices), shown as its own slider row. */
  axis?: { value: number; set: (v: number) => void; count: number; label: string; ariaLabel: string };
  range: FrameRange;
  setRange: (r: FrameRange) => void;
  /** Frames drawn as large dots (key frames such as ED / ES). */
  markers?: number[];
  /** Frames drawn as small dots (e.g. frames with annotations). */
  dotted?: Set<number>;
  /** Extra range buttons, e.g. { label: "ED→ES", range: [0, 12] }. */
  rangePresets?: { label: string; title: string; range: [number, number] }[];
  /** Extra content at the end of the controls row. */
  children?: ReactNode;
}

export function Transport(props: TransportProps) {
  const { playing, onPlay, fps, setFps, mode, setMode, frame, setFrame, frames: nt, axis, range, setRange, markers = [], dotted, rangePresets = [] } = props;
  const pct = (f: number) => `${(f / Math.max(1, nt - 1)) * 100}%`;
  const [a, b] = range;
  const lo = a !== null && b !== null ? Math.min(a, b) : null, hi = a !== null && b !== null ? Math.max(a, b) : null;
  return (
    <div className="space-y-2 border-t border-border px-3 py-2 text-xs">
      <div className="flex items-center gap-3">
        <button
          onClick={onPlay}
          aria-label={playing ? "Pause" : "Play"}
          title="Play / pause (Space)"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary-hover"
        >
          {playing ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
        </button>
        <span className="w-10 shrink-0 text-muted-foreground">Time</span>
        <div className="relative flex-1">
          {lo !== null && hi !== null && (
            <div className="pointer-events-none absolute -top-1 h-1 rounded-full bg-primary/40" style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` }} />
          )}
          <Slider value={[frame]} min={0} max={nt - 1} step={1} onValueChange={([f]) => setFrame(f)} aria-label={props.frameLabel ?? "Frame"} />
          <div className="pointer-events-none absolute -bottom-1.5 left-0 right-0 h-1">
            {Array.from({ length: nt }, (_, f) => (
              <span
                key={f}
                className={cn("absolute h-1 w-1 -translate-x-1/2 rounded-full", markers.includes(f) ? "h-1.5 w-1.5 bg-primary" : dotted?.has(f) ? "bg-muted-foreground" : "")}
                style={{ left: pct(f) }}
              />
            ))}
          </div>
        </div>
        <span className="tnum w-14 shrink-0 text-right text-foreground/80">
          {frame + 1}/{nt}
        </span>
      </div>
      {axis && (
        <div className="flex items-center gap-3">
          <span className="w-7 shrink-0" />
          <span className="w-10 shrink-0 text-muted-foreground">{axis.label}</span>
          <Slider value={[axis.value]} min={0} max={axis.count - 1} step={1} onValueChange={([s]) => axis.set(s)} aria-label={axis.ariaLabel} className="flex-1" />
          <span className="tnum w-14 shrink-0 text-right text-foreground/80">
            {axis.value + 1}/{axis.count}
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-foreground/80">
        <span className="w-7 shrink-0" />
        <span className="w-10 shrink-0 text-muted-foreground">Cine</span>
        <Slider value={[fps]} min={1} max={60} step={1} onValueChange={([v]) => setFps(v)} aria-label="Frames per second" className="w-24" />
        <span className="tnum w-12">{fps} fps</span>
        <ToolbarButton onClick={() => setMode(mode === "loop" ? "bounce" : "loop")} title="Loop restarts at the first frame; bounce plays back and forth">
          {mode === "loop" ? <LoopIcon className="h-3.5 w-3.5" /> : <LoopOnceIcon className="h-3.5 w-3.5" />}
          {mode === "loop" ? "Loop" : "Bounce"}
        </ToolbarButton>
        <ToolbarSep />
        <ToolbarButton onClick={() => setRange([frame, b])} active={a !== null} title="Set the start of the play range to this frame">A{a !== null ? ` ${a + 1}` : ""}</ToolbarButton>
        <ToolbarButton onClick={() => setRange([a, frame])} active={b !== null} title="Set the end of the play range to this frame">B{b !== null ? ` ${b + 1}` : ""}</ToolbarButton>
        {(a !== null || b !== null) && (
          <ToolbarButton onClick={() => setRange([null, null])} title="Play all frames">
            Clear
          </ToolbarButton>
        )}
        {rangePresets.map((p) => (
          <ToolbarButton key={p.label} onClick={() => setRange(p.range)} title={p.title}>
            {p.label}
          </ToolbarButton>
        ))}
        {props.children}
      </div>
    </div>
  );
}

/** Inclusive [from, to] of an A–B range, or the whole sequence when it isn't set. */
export function rangeBounds(range: FrameRange, frames: number): [number, number] {
  const [a, b] = range;
  return a !== null && b !== null ? [Math.min(a, b), Math.max(a, b)] : [0, frames - 1];
}

/**
 * requestAnimationFrame playback loop. Advances whole frames at `fps`, inside [from, to]
 * (inclusive), either wrapping or bouncing at the ends.
 */
export function useFramePlayback(opts: { playing: boolean; fps: number; mode: PlayMode; from: number; to: number; setFrame: (fn: (f: number) => number) => void }) {
  const { playing, fps, mode, from, to, setFrame } = opts;
  const dir = useRef(1);
  useEffect(() => {
    if (!playing || to <= from) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += now - last;
      last = now;
      const period = 1000 / fps;
      let steps = 0;
      while (acc >= period && steps < 4) {
        acc -= period;
        steps++;
      }
      if (acc > period) acc = 0; // tab was hidden; don't fast-forward
      if (steps) {
        setFrame((f) => {
          let x = f < from || f > to ? from : f;
          for (let s = 0; s < steps; s++) {
            if (mode === "loop") x = x >= to ? from : x + 1;
            else {
              if (x + dir.current > to || x + dir.current < from) dir.current = -dir.current;
              x += dir.current;
            }
          }
          return x;
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, fps, mode, from, to, setFrame]);
}
