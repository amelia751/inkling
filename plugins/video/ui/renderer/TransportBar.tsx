import { useState } from "react";
import {
  ChevronLeftIcon as ChevronLeft,
  ChevronRightIcon as ChevronRight,
  CopyIcon as Copy,
  KeyframeIcon as Diamond,
  HideIcon as EyeOff,
  PauseIcon as Pause,
  PlayIcon as Play,
  LoopIcon as Repeat,
  SkipBackIcon as SkipBack,
  SkipForwardIcon as SkipForward,
  StepBackIcon as StepBack,
  StepForwardIcon as StepForward,
  CloseIcon as X,
} from "@studio/studio-ui/icons";
import { formatCombo, resolveShortcut, shortcutLabel } from "@studio/studio-ui/shortcuts";
import { cn } from "@studio/studio-ui/utils";
import { BarIconButton, BarTextButton } from "@studio/studio-renderers/viewport-chrome/controls";
import { formatTime } from "@studio/studio-renderers/viewport-chrome/format";
import type { Annotation } from "@studio/plugin-contracts/types";
import { isSpatial, keyframeAt, shapeAt, sortKeyframes, toggleKeyframe, toggleOccluded, toggleOutside, type TrackGeometry } from "../tracks";
import { cmd } from "./StageBars";
import type { VideoEngine, VideoState } from "./VideoEngine";
import { NS } from "@studio/plugin-contracts/naming";

const RATES = [0.25, 0.5, 1, 1.5, 2];
const core = (n: string) => `${NS}.core.commands.${n}`;
/** The n-th bound combo of a command, formatted ("" when unbound). */
const key = (id: string, n = 0) => {
  const k = resolveShortcut(id)?.keys[n];
  return k ? formatCombo(k) : "";
};

/** Transport (first / step / play / last, time, frame box, rate, loop, A–B) and the selected track's keyframe controls. */
export function TransportBar(p: {
  engine: VideoEngine;
  state: VideoState;
  frame: number;
  selected: Annotation | null;
  trackNumber?: number;
  trackEditable: boolean;
  tool: string;
  perFrame: boolean;
  editTracks: (fn: (g: TrackGeometry, f: number) => TrackGeometry) => void;
  jumpKeyframe: (dir: -1 | 1) => void;
  copyToNext: () => void;
}) {
  const { engine, state: s, selected } = p;
  const target = s.target;
  const range = s.range;
  const track = selected?.geometry.type === "track" ? (selected.geometry as TrackGeometry) : null;
  const kfHere = track ? keyframeAt(track, p.frame) : undefined;
  const selShape = track ? shapeAt(track, p.frame) : null;
  const step = (n: 0 | 1) => `${key(core(n ? "nextFrame" : "prevFrame"))} or ${key(cmd("stepFrame"), n)}  (Shift: 10)`;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1">
      <BarIconButton label="First frame" shortcut={key(cmd("firstLastFrame"))} onClick={() => engine.seekEnd("first")} icon={SkipBack} />
      <BarIconButton label="Previous frame" shortcut={step(0)} onClick={() => engine.step(-1)} icon={StepBack} />
      <BarIconButton label={s.playing ? "Pause" : "Play"} shortcut={shortcutLabel(core("playPause"))} onClick={engine.togglePlay} icon={s.playing ? Pause : Play} primary disabled={!s.videoReady || !s.clockReady} />
      <BarIconButton label="Next frame" shortcut={step(1)} onClick={() => engine.step(1)} icon={StepForward} />
      <BarIconButton label="Last frame" shortcut={key(cmd("firstLastFrame"), 1)} onClick={() => engine.seekEnd("last")} icon={SkipForward} />

      <span className="tnum ml-1 text-xs text-canvas-foreground/70">{formatTime(target / engine.fps)}</span>
      <FrameInput frame={target} frames={s.frames} onSeek={engine.seek} />

      <div className="mx-1 h-4 w-px bg-white/10" />
      <div className="flex items-center gap-0.5 text-xs">
        {RATES.map((r) => (
          <button
            key={r}
            onClick={() => engine.setRate(r)}
            className={cn("tnum rounded-md px-1.5 py-0.5 transition-colors", r === s.rate ? "bg-white/15 text-canvas-foreground" : "text-canvas-foreground/60 hover:bg-white/10")}
          >
            {r}×
          </button>
        ))}
      </div>
      <BarIconButton label={s.loop ? "Loop on" : "Loop off"} shortcut={shortcutLabel(cmd("toggleLoop"))} onClick={() => engine.setLoop(!s.loop)} icon={Repeat} active={s.loop} />
      <div className="flex items-center gap-0.5 text-xs">
        <BarTextButton title="Set loop start (A) at the playhead · or Shift-drag the ruler" onClick={() => engine.setRange({ a: target, b: range && range.b > target ? range.b : s.frames - 1 })} active={!!range}>
          A{range ? ` ${range.a + 1}` : ""}
        </BarTextButton>
        <BarTextButton title="Set loop end (B) at the playhead" onClick={() => engine.setRange({ a: range && range.a < target ? range.a : 0, b: target })} active={!!range}>
          B{range ? ` ${range.b + 1}` : ""}
        </BarTextButton>
        {range && <BarIconButton label="Clear A–B range" onClick={() => engine.setRange(null)} icon={X} />}
      </div>

      <div className="ml-auto flex items-center gap-0.5 text-xs">
        {track && selected ? (
          <>
            <span className="mr-1 text-canvas-foreground/70">
              #{p.trackNumber} <span className="capitalize">{selected.label}</span> · {sortKeyframes(track.keyframes).length} keyframes
            </span>
            <BarIconButton label="Previous keyframe" shortcut={shortcutLabel(cmd("prevKeyframe"))} onClick={() => p.jumpKeyframe(-1)} icon={ChevronLeft} />
            <BarIconButton label={kfHere ? "Remove keyframe" : "Add keyframe"} shortcut={shortcutLabel(cmd("toggleKeyframe"))} onClick={() => p.editTracks(toggleKeyframe)} icon={Diamond} active={!!kfHere} disabled={!p.trackEditable} />
            <BarIconButton label="Next keyframe" shortcut={shortcutLabel(cmd("nextKeyframe"))} onClick={() => p.jumpKeyframe(1)} icon={ChevronRight} />
            <BarIconButton label={selShape ? "Mark outside (hide from here)" : "Bring back in view"} shortcut={shortcutLabel(cmd("toggleOutside"))} onClick={() => p.editTracks(toggleOutside)} icon={EyeOff} active={!selShape} disabled={!p.trackEditable} />
            <BarTextButton title={`Toggle occluded (${shortcutLabel(cmd("toggleOccluded"))})`} onClick={() => p.editTracks(toggleOccluded)} active={!!selShape?.occluded} disabled={!p.trackEditable || !selShape}>
              Occluded
            </BarTextButton>
            <BarIconButton label="Copy to next frame" shortcut={shortcutLabel(cmd("copyToNextFrame"))} onClick={p.copyToNext} icon={Copy} disabled={!p.trackEditable || !selShape} />
          </>
        ) : selected && isSpatial(selected.geometry) ? (
          <BarIconButton label="Copy to next frame" shortcut={shortcutLabel(cmd("copyToNextFrame"))} onClick={p.copyToNext} icon={Copy} />
        ) : (
          <span className="text-canvas-foreground/45">{hint(p.tool, p.perFrame)}</span>
        )}
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
          // Typing a frame number is not a shortcut.
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
