import { SettingsIcon } from "@studio/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@studio/ui/ui/popover";
import { Slider } from "@studio/ui/ui/slider";
import { cn } from "@studio/ui/utils";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { publish, useRuntime } from "@studio/plugin-ui-sdk/runtime";
import { NEUTRAL_ADJUST, type Adjustments } from "../renderer/wandCore";

const ROWS: { key: keyof Adjustments; label: string; min: number; max: number }[] = [
  { key: "brightness", label: "Brightness", min: 0.3, max: 2 },
  { key: "contrast", label: "Contrast", min: 0.3, max: 3 },
  { key: "gamma", label: "Gamma", min: 0.3, max: 3 },
  { key: "saturation", label: "Saturation", min: 0, max: 3 },
];

/**
 * `studio.wsi.panels.adjust` (slot viewport-bar): brightness, contrast, gamma and
 * saturation of the slide's tiles. The value goes to the runtime as `adjust` for the
 * current item; the renderer applies it as a CSS filter and the wand samples through it.
 */
export function AdjustPanel({ item }: PanelProps) {
  const adjust = useRuntime<Adjustments>(item?.id, "adjust") ?? NEUTRAL_ADJUST;
  if (!item) return null;
  const set = (next: Adjustments) => publish(item.id, "adjust", next);
  const changed = (Object.keys(adjust) as (keyof Adjustments)[]).some((k) => adjust[k] !== 1);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn("rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground", changed && "bg-accent text-foreground")} aria-label="Image adjustments" title="Brightness, contrast, gamma, saturation">
          <SettingsIcon className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-3 p-3 text-xs">
        {ROWS.map((r) => (
          <div key={r.key} className="space-y-1.5">
            <div className="flex justify-between">
              <span>{r.label}</span>
              <span className="tnum text-muted-foreground">{adjust[r.key].toFixed(2)}</span>
            </div>
            <Slider value={[adjust[r.key]]} min={r.min} max={r.max} step={0.01} onValueChange={([v]) => set({ ...adjust, [r.key]: v })} aria-label={r.label} />
          </div>
        ))}
        <button className="w-full rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50" disabled={!changed} onClick={() => set(NEUTRAL_ADJUST)}>
          Reset
        </button>
        <p className="text-muted-foreground">Display only; the wand samples the adjusted colours.</p>
      </PopoverContent>
    </Popover>
  );
}
