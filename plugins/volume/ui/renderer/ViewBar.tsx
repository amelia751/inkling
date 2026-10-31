import {
  CopyIcon as Copy,
  FillIcon as Fill,
  FitIcon as Maximize,
  FlipHorizontalIcon as FlipHorizontal2,
  FlipVerticalIcon as FlipVertical2,
  HideIcon as EyeOff,
  InterpolateIcon as Wand2,
  InvertIcon as Contrast,
  ProjectionIcon as Layers,
  RotateLeftIcon as RotateCcw,
  RotateRightIcon as RotateCw,
  SearchIcon as Search,
  ShowIcon as Eye,
  CleanupIcon as Sparkles,
  VolumeIcon as Box,
} from "@studio/ui/icons";
import { COLORMAPS, CT_PRESETS } from "@studio/renderers/cornerstone/viewControls";
import { BarButton, BarLabel, BarSelect, BarSep, ViewportBar } from "@studio/renderers/viewport-chrome/bar";
import { OverlayOpacityControl } from "@studio/renderers/viewport-chrome/opacity";
import { formatCombo } from "@studio/ui/keys";
import type { Plane } from "@studio/contracts/types";
import { LAYOUT_LABELS, PLANES, usesPlanePicker, type Layout } from "../config";
import type { VolumeSource } from "../dataKind";
import { VOLUME_COMMANDS as C } from "../commands";
import type { WandMode } from "./MprEngine";
import { commandDef } from "@studio/plugin-ui-sdk";

/** "Invert (⇧I)": a title with the command's current key, never a hard-coded one. */
function withKey(text: string, command: string): string {
  const d = commandDef(command);
  const key = d && (d.display ?? (d.keys[0] ? formatCombo(d.keys[0]) : ""));
  return key ? `${text} (${key})` : text;
}

export interface ViewBarProps {
  run: (command: string) => void;
  sequences: VolumeSource[];
  sequence: string | undefined;
  onSequence: (key: string) => void;
  modality: string | undefined;
  layout: Layout;
  layouts: Layout[];
  onLayout: (l: Layout) => void;
  single: Plane;
  onSingle: (p: Plane) => void;
  modalityIsCT: boolean;
  onWindow: (v: string) => void;
  inverted: boolean;
  colormap: string;
  onColormap: (name: string) => void;
  linear: boolean;
  onLinear: () => void;
  mip: boolean;
  onMip: () => void;
  hasReference: boolean;
  showRef: boolean;
  refReady: boolean;
  onShowRef: () => void;
  onCopyReference: () => void;
  magnify: boolean;
  tool: string;
  wandMode: WandMode;
  sphere: boolean;
  onSphere: () => void;
  activeCell: Plane;
  busy: string | null;
}

/** The renderer's own viewport bar: sequence, layout, window, view transforms, mask actions. */
export function ViewBar(p: ViewBarProps) {
  const segTool = p.tool === "brush" || p.tool === "eraser" || p.tool === "wand";
  const layouts = p.layouts.includes(p.layout) ? p.layouts : [...p.layouts, p.layout];
  return (
    <ViewportBar>
      <BarLabel>{p.sequences.length > 1 ? "Sequence" : p.modality ?? "Series"}</BarLabel>
      {p.sequences.length > 1 &&
        p.sequences.map((a) => (
          <BarButton
            key={a.key}
            label={<span className="uppercase tracking-wide">{a.label}</span>}
            title={`Show the ${a.label.toUpperCase()} sequence (camera and masks are kept)`}
            active={a.key === p.sequence}
            onClick={() => p.onSequence(a.key)}
          />
        ))}
      <BarSep />
      <BarSelect title="Layout" value={p.layout} options={layouts.map((value) => ({ value, label: LAYOUT_LABELS[value] }))} onChange={p.onLayout} />
      {usesPlanePicker(p.layout) && (
        <BarSelect title="Plane" value={p.single} options={PLANES.map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) }))} onChange={p.onSingle} />
      )}
      <BarSep />
      <BarSelect
        title="Window / level"
        value=""
        options={[
          { value: "", label: "Window" },
          { value: "auto", label: "Auto (0.5–99.5%)" },
          { value: "full", label: "Full range" },
          ...(p.modalityIsCT ? CT_PRESETS.map((x) => ({ value: x.id, label: `${x.label} ${x.window}/${x.level}` })) : []),
        ]}
        onChange={p.onWindow}
      />
      <BarButton icon={Contrast} title={withKey("Invert", C.invert)} active={p.inverted} onClick={() => p.run(C.invert)} />
      <OverlayOpacityControl tone="canvas" />
      <BarButton icon={FlipHorizontal2} title={withKey("Flip active view horizontally", C.flipH)} onClick={() => p.run(C.flipH)} />
      <BarButton icon={FlipVertical2} title={withKey("Flip active view vertically", C.flipV)} onClick={() => p.run(C.flipV)} />
      <BarButton icon={RotateCcw} title={withKey("Rotate active view 90° left", C.rotateLeft)} onClick={() => p.run(C.rotateLeft)} />
      <BarButton icon={RotateCw} title={withKey("Rotate active view 90° right", C.rotateRight)} onClick={() => p.run(C.rotateRight)} />
      <BarButton icon={Maximize} title={withKey("Reset views", C.fitView)} onClick={() => p.run(C.fitView)} />
      <BarSelect title="Color map" value={p.colormap} options={COLORMAPS} onChange={p.onColormap} />
      <BarButton label={p.linear ? "Smooth" : "Voxels"} title="Interpolation: smooth (linear) or nearest-neighbour voxels" active={!p.linear} onClick={p.onLinear} />
      <BarButton icon={Layers} label="MIP" title="Maximum-intensity projection over a 10 mm slab" active={p.mip} onClick={p.onMip} />
      <BarSep />
      {p.hasReference && (
        <>
          <BarButton
            icon={p.showRef ? Eye : EyeOff}
            label="Reference mask"
            title="Show the dataset's reference segmentation (read-only outline)"
            active={p.showRef && p.refReady}
            disabled={!p.refReady}
            onClick={p.onShowRef}
          />
          <BarButton icon={Copy} label="Copy to my mask" title="Create editable masks from the reference segmentation (replaces your masks for those labels)" disabled={!p.refReady} onClick={p.onCopyReference} />
        </>
      )}
      <BarButton icon={Search} label="Magnify" title={withKey("Magnifier: 3× loupe under the cursor", C.magnifier)} active={p.magnify} onClick={() => p.run(C.magnifier)} />
      {p.tool === "wand" && (
        <>
          <BarSep />
          <BarButton label="Similar intensity" title="Fill: flood the connected region on this slice within ±8% of the window" active={p.wandMode === "flood"} onClick={() => p.run(C.similarFill)} />
          <BarButton
            icon={Fill}
            label="Smart fill"
            title="Smart fill: 3D adaptive region growing from the clicked structure's own intensity statistics (confidence-connected, no AI model)"
            active={p.wandMode === "smart"}
            onClick={() => p.run(C.smartFill)}
          />
        </>
      )}
      {segTool && (
        <>
          <BarSep />
          <BarButton icon={Wand2} label="Interpolate" title={`Fill slices between painted ${p.activeCell} slices of the active label`} disabled={!!p.busy} onClick={() => p.run(C.interpolate)} />
          <BarButton icon={Sparkles} label="Remove islands" title="Keep only the largest connected region of the active label" disabled={!!p.busy} onClick={() => p.run(C.removeIslands)} />
          {p.tool !== "wand" && <BarButton icon={Box} label="3D brush" title="Paint a sphere through neighbouring slices instead of a circle" active={p.sphere} onClick={p.onSphere} />}
        </>
      )}
      {p.busy && <span className="ml-auto text-[11px] text-canvas-foreground/60">Working…</span>}
    </ViewportBar>
  );
}
