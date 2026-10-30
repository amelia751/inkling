import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, FitIcon, GridIcon, HideIcon, ShowIcon } from "@studio/studio-ui/icons";
import { ToolbarButton, ToolbarSep } from "@studio/studio-renderers/viewport-chrome/controls";
import type { CineConfig } from "../config";
import type { PhaseMark } from "../model";

/** Key frames, copy / interpolate, reference and display controls above the canvas. */
export function CineToolbar(p: {
  keyFrames: CineConfig["keyFrames"];
  phases: Record<string, PhaseMark | null>;
  frame: number;
  onGotoFrame: (f: number) => void;
  onMark: (id: string) => void;
  onCopy: (dz: number, df: number, replace: boolean) => void;
  onInterpolate: (axis: "frame" | "slice") => void;
  wrapCycle: boolean;
  onWrap: () => void;
  hasRefs: boolean;
  refHere: boolean;
  showRef: boolean;
  onShowRef: () => void;
  onImport: (scope: "slice" | "all") => void;
  allRefsLabel: string;
  onAuto: () => void;
  onFull: () => void;
  invert: boolean;
  onInvert: () => void;
  smooth: boolean;
  onSmooth: () => void;
  onFit: () => void;
  matrixOpen: boolean;
  onMatrix: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-border px-2 py-1.5 text-xs">
      {p.keyFrames.map(({ id, label }) => {
        const m = p.phases[id];
        return (
          <ToolbarButton
            key={id}
            active={!!m && p.frame === m.frame}
            onClick={() => m && p.onGotoFrame(m.frame)}
            disabled={!m}
            title={`${label}${m ? ` · frame ${m.frame + 1} (${m.source === "marked" ? "marked" : m.source === "reference" ? "from reference" : "from metadata"})` : " · not set"}`}
          >
            {id} {m ? m.frame + 1 : "—"}
            {m && m.source !== "marked" && <span className="text-hint">*</span>}
          </ToolbarButton>
        );
      })}
      {p.keyFrames.map(({ id, label }) => (
        <ToolbarButton key={id} onClick={() => p.onMark(id)} title={`Mark the current frame as ${label.toLowerCase()}`}>
          Set {id}
        </ToolbarButton>
      ))}
      {p.keyFrames.length > 0 && <ToolbarSep />}
      <span className="text-muted-foreground">Copy</span>
      <ToolbarButton onClick={(e) => p.onCopy(0, -1, e.shiftKey)} title="Copy selected (or all) contours to the previous frame (Alt+←). Shift replaces what is there"><ArrowLeftIcon className="h-3.5 w-3.5" /></ToolbarButton>
      <ToolbarButton onClick={(e) => p.onCopy(0, 1, e.shiftKey)} title="Copy to the next frame (Alt+→)"><ArrowRightIcon className="h-3.5 w-3.5" /></ToolbarButton>
      <ToolbarButton onClick={(e) => p.onCopy(-1, 0, e.shiftKey)} title="Copy to the previous slice (Alt+↑)"><ArrowUpIcon className="h-3.5 w-3.5" /></ToolbarButton>
      <ToolbarButton onClick={(e) => p.onCopy(1, 0, e.shiftKey)} title="Copy to the next slice (Alt+↓)"><ArrowDownIcon className="h-3.5 w-3.5" /></ToolbarButton>
      <span className="ml-1 text-muted-foreground">Interpolate</span>
      <ToolbarButton onClick={() => p.onInterpolate("frame")} title="Fill empty frames of this slice between key contours of the selected/active structure">frames</ToolbarButton>
      <ToolbarButton onClick={() => p.onInterpolate("slice")} title="Fill empty slices of this frame between key contours of the selected/active structure">slices</ToolbarButton>
      <ToolbarButton onClick={p.onWrap} active={p.wrapCycle} title="Frame interpolation wraps around the cycle (last key frame → first)">wrap</ToolbarButton>
      <ToolbarSep />
      <span className="text-muted-foreground">Reference</span>
      <ToolbarButton onClick={p.onShowRef} disabled={!p.hasRefs} active={p.showRef && p.refHere} title="Show the reference segmentation outline on frames that have one">
        {p.showRef ? <ShowIcon className="h-3.5 w-3.5" /> : <HideIcon className="h-3.5 w-3.5" />}
      </ToolbarButton>
      <ToolbarButton onClick={() => p.onImport("slice")} disabled={!p.refHere} title="Convert the reference on this slice into editable spline contours">→ contours</ToolbarButton>
      <ToolbarButton onClick={() => p.onImport("all")} disabled={!p.hasRefs} title="Convert the reference on every slice of every reference frame">{p.allRefsLabel}</ToolbarButton>
      <div className="ml-auto flex items-center gap-1">
        <span className="text-muted-foreground">W/L</span>
        <ToolbarButton onClick={p.onAuto} title="Auto window: 1st–99th percentile">Auto</ToolbarButton>
        <ToolbarButton onClick={p.onFull} title="Full intensity range">Full</ToolbarButton>
        <ToolbarButton onClick={p.onInvert} active={p.invert} title="Invert grey scale">Inv</ToolbarButton>
        <ToolbarButton onClick={p.onSmooth} active={p.smooth} title="Bilinear interpolation (off = nearest neighbour pixels)">Smooth</ToolbarButton>
        <ToolbarButton onClick={p.onFit} title="Fit to view (=)"><FitIcon className="h-3.5 w-3.5" /></ToolbarButton>
        <ToolbarSep />
        <ToolbarButton onClick={p.onMatrix} active={p.matrixOpen} title="Slice × frame matrix"><GridIcon className="h-3.5 w-3.5" /></ToolbarButton>
      </div>
    </div>
  );
}
