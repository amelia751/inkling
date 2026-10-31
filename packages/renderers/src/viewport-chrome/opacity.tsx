import { OverlayOpacityIcon } from "@studio/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@studio/ui/ui/popover";
import { Slider } from "@studio/ui/ui/slider";
import { cn } from "@studio/ui/utils";
import { useHost } from "@studio/plugin-ui-sdk";

/**
 * Overlay opacity in a renderer's view menu (todo8 D2): a view setting, next to window/level
 * and invert, not a label setting. Reads and writes the Studio's `overlayOpacity`, so every
 * renderer that honours it follows. `tone="canvas"` for the dark bar inside the canvas.
 * Renderers that use it declare the `overlayOpacity` capability, so the Labels panel drops
 * its own copy of the slider.
 */
export function OverlayOpacityControl({ tone = "app" }: { tone?: "app" | "canvas" }) {
  const opacity = useHost((s) => s.overlayOpacity);
  const setOpacity = useHost((s) => s.setOverlayOpacity);
  const pct = Math.round(opacity * 100);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Overlay opacity"
          aria-label={`Overlay opacity ${pct}%`}
          data-testid="overlay-opacity"
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs transition-colors",
            tone === "canvas"
              ? "text-canvas-foreground/75 hover:bg-white/10 hover:text-canvas-foreground data-[state=open]:bg-white/10"
              : "text-muted-foreground hover:bg-generic hover:text-foreground data-[state=open]:bg-generic",
          )}
        >
          <OverlayOpacityIcon className="h-3.5 w-3.5" />
          <span className="tnum">{pct}%</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3">
        <div className="mb-2 flex items-center text-xs text-muted-foreground">
          Overlay opacity
          <span className="tnum ml-auto text-foreground">{pct}%</span>
        </div>
        <Slider value={[opacity]} min={0} max={1} step={0.05} onValueChange={([v]) => setOpacity(v)} aria-label="Overlay opacity" />
      </PopoverContent>
    </Popover>
  );
}
