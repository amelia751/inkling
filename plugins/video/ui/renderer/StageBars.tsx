import { FitIcon as Scan, RegionIcon as SquareDashed, SettingsIcon as SlidersHorizontal, ZoomInIcon as ZoomIn, ZoomOutIcon as ZoomOut } from "@studio/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@studio/ui/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { shortcutLabel } from "@studio/ui/shortcuts";
import { cn } from "@studio/ui/utils";
import { BarIconButton } from "@studio/renderers/viewport-chrome/controls";
import type { DecodeMode } from "./VideoEngine";
import { NS } from "@studio/contracts/naming";

export type Adjust = { brightness: number; contrast: number; saturation: number };
export const NO_ADJUST: Adjust = { brightness: 100, contrast: 100, saturation: 100 };
export const cmd = (name: string) => `${NS}.video.commands.${name}`;

/** Top-left of the stage: track vs per-frame drawing mode, and how frames are decoded. */
export function ModeBar({ perFrame, onPerFrame, mode, fallbackReason }: { perFrame: boolean; onPerFrame: (v: boolean) => void; mode: DecodeMode; fallbackReason: string | null }) {
  return (
    <div className="absolute left-2 top-2 flex items-center gap-1.5 text-xs">
      <div className="flex rounded-md bg-black/55 p-0.5 backdrop-blur" role="radiogroup" aria-label="Drawing mode">
        {([
          [false, "Track", "Shapes become object tracks with keyframes; frames in between are interpolated"],
          [true, "Per-frame", `Shapes exist on one frame only (${shortcutLabel(cmd("copyToNextFrame"))} copies to the next frame)`],
        ] as const).map(([v, label, hint]) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <button
                role="radio"
                aria-checked={perFrame === v}
                onClick={() => onPerFrame(v)}
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
  );
}

/** Top-right of the stage: zoom, fit, 1:1 and brightness / contrast / saturation. */
export function ViewBar({ scale, zoomBy, fit, actualSize, adjust, onAdjust }: { scale: number; zoomBy: (f: number) => void; fit: () => void; actualSize: () => void; adjust: Adjust; onAdjust: (a: Adjust) => void }) {
  const changed = adjust.brightness !== 100 || adjust.contrast !== 100 || adjust.saturation !== 100;
  return (
    <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-md bg-black/55 p-0.5 text-white backdrop-blur">
      <BarIconButton label="Zoom out" onClick={() => zoomBy(1 / 1.25)} icon={ZoomOut} />
      <span className="tnum w-11 text-center text-xs text-white/80">{Math.round(scale * 100)}%</span>
      <BarIconButton label="Zoom in" onClick={() => zoomBy(1.25)} icon={ZoomIn} />
      <BarIconButton label="Fit" shortcut={shortcutLabel(cmd("fitView"))} onClick={fit} icon={Scan} />
      <BarIconButton label="Actual size (1:1)" onClick={actualSize} icon={SquareDashed} />
      <Popover>
        <PopoverTrigger asChild>
          <button aria-label="Image adjustments" title="Brightness, contrast, saturation" className={cn("flex h-7 w-7 items-center justify-center rounded hover:bg-white/15", changed && "text-primary")}>
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
              <input type="range" min={0} max={300} step={5} value={adjust[k]} onChange={(e) => onAdjust({ ...adjust, [k]: +e.target.value })} className="w-full accent-[hsl(var(--primary))]" />
            </label>
          ))}
          <button className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => onAdjust(NO_ADJUST)}>
            Reset
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
