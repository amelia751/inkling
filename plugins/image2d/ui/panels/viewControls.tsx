import type { ReactNode } from "react";
import {
  ChevronDownIcon,
  CleanupIcon,
  FillIcon,
  FitIcon,
  FlipHorizontalIcon,
  FlipVerticalIcon,
  InvertIcon,
  RotateLeftIcon,
  RotateRightIcon,
  SearchIcon,
  ZoomInIcon,
  type IconComponent,
} from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { ActionTooltipContent, Tooltip, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { cn } from "@studio/ui/utils";
import { formatCombo } from "@studio/ui/keys";
import { OverlayOpacityControl } from "@studio/renderers/viewport-chrome/opacity";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { useRuntime } from "@studio/plugin-ui-sdk/runtime";
import { COMMANDS, VIEW_CONTROLS, VIEW_STATE, type ViewControls, type ViewState } from "../view";
import { commandDef, useHost } from "@studio/plugin-ui-sdk";

/** First key of a command as bound in the active environment ("⇧I"), if any. */
function keyOf(command: string): string | undefined {
  const k = commandDef(command)?.keys[0];
  return k ? formatCombo(k) : undefined;
}
const withKey = (title: string, command: string) => {
  const k = keyOf(command);
  return k ? `${title} (${k})` : title;
};

function Sep() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-border" />;
}

function IconButton({ icon: Icon, label, command, active, onClick, children }: { icon: IconComponent; label: string; command?: string; active?: boolean; onClick: () => void; children?: ReactNode }) {
  const name = command ? withKey(label, command) : label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost-secondary" size={children ? "sm" : "icon"} selected={active} aria-pressed={active} aria-label={name} onClick={onClick} className="shrink-0">
          <Icon />
          {children}
        </Button>
      </TooltipTrigger>
      <ActionTooltipContent title={label} shortcut={command ? commandDef(command)?.keys[0] : undefined} />
    </Tooltip>
  );
}

function Select({ title, value, options, onChange }: { title: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select
      title={title}
      aria-label={title}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        // Give keys back to the studio shortcuts (a focused <select> swallows arrows).
        e.target.blur();
      }}
      className="h-7 shrink-0 rounded-md border border-border bg-background px-1.5 text-xs text-foreground outline-none hover:bg-generic focus:border-primary"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function MenuRow({ icon: Icon, label, command, shortcut, onSelect }: { icon: IconComponent; label: string; command?: string; shortcut?: string; onSelect: () => void }) {
  const k = shortcut ?? (command ? keyOf(command) : undefined);
  return (
    <DropdownMenuItem onSelect={onSelect}>
      <Icon />
      {label}
      {k && <DropdownMenuShortcut>{k}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  );
}

/**
 * Viewport-bar controls of the Cornerstone stack renderer: window/level presets, invert,
 * overlay opacity, then a View ▾ menu (todo8 D4: the Zoom tool, fit, flip and rotate, the
 * view actions people reach for rarely and mostly by key), then color map, interpolation and
 * magnifier, plus the wand mode and "remove islands" while a mask tool is active. Each group
 * shows only when the renderer's config keeps it (`windowLevel: false` for natural photos…).
 * Reads the state and actions the renderer publishes in the item runtime; renders nothing for
 * other renderers.
 */
export function ViewControlsPanel({ env, item }: PanelProps) {
  const view = useRuntime<ViewState>(item?.id, VIEW_STATE);
  const act = useRuntime<ViewControls>(item?.id, VIEW_CONTROLS);
  const tool = useHost((s) => s.tool);
  const setTool = useHost((s) => s.setTool);
  // The toolbar hides Zoom (scroll already zooms); it lives here, with its key.
  const zoom = env.tools.find((t) => t.name === "zoom");
  if (!view || !act) return null;
  const f = view.features;
  const segTools = tool === "brush" || tool === "eraser" || tool === "wand";

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="View controls">
      {f.windowLevel && <Select title="Window / level preset" value="" options={view.voiOptions} onChange={act.applyVoiPreset} />}
      {f.invert && <IconButton icon={InvertIcon} label="Invert" command={COMMANDS.invert} active={view.invert} onClick={act.toggleInvert} />}
      <OverlayOpacityControl />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost-secondary" size="sm" selected={tool === "zoom"} aria-label="View" data-testid="view-menu" className="shrink-0 gap-0.5 px-1.5 text-xs">
            View
            <ChevronDownIcon className="h-3 w-3 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {zoom && <MenuRow icon={ZoomInIcon} label="Zoom tool" shortcut={zoom.hotkey ? formatCombo(zoom.hotkey) : undefined} onSelect={() => setTool(zoom.name)} />}
          <MenuRow icon={FitIcon} label="Reset view (fit)" command={COMMANDS.fit} onSelect={act.reset} />
          {(f.flip || f.rotate) && <DropdownMenuSeparator />}
          {f.flip && <MenuRow icon={FlipHorizontalIcon} label="Flip horizontal" command={COMMANDS.flipH} onSelect={() => act.flip("h")} />}
          {f.flip && <MenuRow icon={FlipVerticalIcon} label="Flip vertical" command={COMMANDS.flipV} onSelect={() => act.flip("v")} />}
          {f.rotate && <MenuRow icon={RotateLeftIcon} label="Rotate 90° left" command={COMMANDS.rotateLeft} onSelect={() => act.rotate(-90)} />}
          {f.rotate && <MenuRow icon={RotateRightIcon} label="Rotate 90° right" command={COMMANDS.rotateRight} onSelect={() => act.rotate(90)} />}
        </DropdownMenuContent>
      </DropdownMenu>
      {(f.colormap || f.interpolation || f.magnifier) && <Sep />}
      {f.colormap && <Select title="Color map" value={view.colormap} options={view.colormaps} onChange={act.setColormap} />}
      {f.interpolation && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost-secondary"
              size="sm"
              selected={!view.linear}
              aria-pressed={!view.linear}
              aria-label="Interpolation: smooth (linear) or nearest-neighbour pixels"
              onClick={act.toggleInterpolation}
              className={cn("w-14 shrink-0 justify-center text-xs")}
            >
              {view.linear ? "Smooth" : "Pixels"}
            </Button>
          </TooltipTrigger>
          <ActionTooltipContent title="Interpolation" description="Smooth (linear) or nearest-neighbour pixels" />
        </Tooltip>
      )}
      {f.magnifier && <IconButton icon={SearchIcon} label="Magnifier: 3× loupe under the cursor" command={COMMANDS.magnifier} active={view.magnify} onClick={act.toggleMagnifier} />}
      {tool === "wand" && (
        <>
          <Sep />
          <Button variant="ghost-secondary" size="sm" selected={view.wandMode === "flood"} aria-pressed={view.wandMode === "flood"} title="Fill: flood the connected region within ±8% of the window around the clicked pixel" onClick={() => act.setWandMode("flood")} className="shrink-0 text-xs">
            Similar intensity
          </Button>
          <Button variant="ghost-secondary" size="sm" selected={view.wandMode === "smart"} aria-pressed={view.wandMode === "smart"} title="Smart fill: adaptive region growing from the clicked structure's own intensity statistics (confidence-connected, no AI model)" onClick={() => act.setWandMode("smart")} className="shrink-0 text-xs">
            <FillIcon />
            Smart fill
          </Button>
        </>
      )}
      {segTools && (
        <>
          <Sep />
          <Button variant="ghost-secondary" size="sm" title="Keep only the largest connected region of the active label's mask" onClick={act.removeIslands} className="shrink-0 text-xs">
            <CleanupIcon />
            Remove islands
          </Button>
        </>
      )}
    </div>
  );
}
