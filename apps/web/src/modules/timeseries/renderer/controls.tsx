import { CardiacIcon as HeartPulse, SpinnerIcon as Loader2 } from "@/components/icons";
import { BarPick, BarSegmented, BarToggle } from "@/kits/viewport-chrome/controls";
import { cn } from "@/lib/utils";
import type { Code, StripChartConfig } from "../config";
import { isPassthrough, type FilterConfig } from "../dsp";
import type { LayoutMode, ScaleMode } from "./layout";

/** Display bar, tool-option strip and channel menu of the strip chart (thin, stateless views). */

export function filterText(c: FilterConfig): string {
  if (isPassthrough(c)) return "unfiltered";
  const band = `${c.hp || "DC"}–${c.lp || "∞"} Hz`;
  return c.notch ? `${band} · ${c.notch} Hz notch` : band;
}

const WINDOWS = [10, 5, 2.5, 1];
export const SPEEDS = [12.5, 25, 50, 100];
const GAINS = [5, 10, 20];
const HP = [0, 0.05, 0.5];
const NOTCH = [0, 50, 60];
const LP = [0, 40, 100, 150];
const withValue = (list: number[], v: number) => (list.includes(v) ? list : [...list, v].sort((a, b) => a - b));

export const CONFIG_LAYOUT: Record<StripChartConfig["layout"], LayoutMode> = { stacked: "12x1", "6x2": "6x2", "3x4": "3x4", single: "single" };

export interface Display {
  layout: LayoutMode;
  /** Layout to return to when leaving single-channel focus. */
  prevLayout: Exclude<LayoutMode, "single">;
  focus: string;
  scale: ScaleMode;
  speed: number;
  gain: number;
  /** Per-channel gain override, mm per unit. */
  leadGain: Record<string, number>;
  hp: number;
  notch: number;
  lp: number;
  snap: boolean;
  marchOut: boolean;
}

export function DisplayBar(p: {
  cfg: StripChartConfig;
  channels: number;
  display: Display;
  /** True paper scale in effect (ECG grid only). */
  paper: boolean;
  setDisplay: (d: Partial<Display>) => void;
  windowSec: number;
  setWindow: (w: number) => void;
  calibrated: boolean;
  pxPerMm: number;
  onCalibrate: () => void;
  filterPending: boolean;
  detecting: boolean;
  canDetect: boolean;
  onDetect: () => void;
}) {
  const { cfg, display, setDisplay } = p;
  const gainUnit = cfg.unit ? `mm/${cfg.unit}` : "mm/unit";
  const filters: FilterConfig = { hp: display.hp, notch: display.notch, lp: display.lp };
  const filtersOn = !isPassthrough(filters);
  const layouts = cfg.layouts.map((l) => {
    const v = CONFIG_LAYOUT[l];
    return v === "12x1"
      ? { v, label: `${p.channels || ""}×1`, title: `Every ${cfg.channelNoun} stacked (annotation view)` }
      : v === "6x2"
        ? { v, label: "6×2", title: "Two columns, consecutive time" }
        : v === "3x4"
          ? { v, label: "3×4", title: `Four columns of 2.5 s${cfg.primaryChannel ? ` + ${cfg.channelNoun} ${cfg.primaryChannel} rhythm strip` : ""}` }
          : { v, label: "1", title: `Single-${cfg.channelNoun} focus (click a ${cfg.channelNoun} name)` };
  });
  const detectLead = display.layout === "single" ? display.focus : (cfg.primaryChannel ?? "");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/10 px-3 py-1.5 text-xs">
      {layouts.length > 1 && (
        <BarSegmented label="Layout" value={display.layout} options={layouts} onChange={(layout) => setDisplay(layout === "single" ? { layout } : { layout, prevLayout: layout })} />
      )}
      {cfg.grid === "ecg" && (
        <BarSegmented
          label="Scale"
          value={display.scale}
          options={[
            { v: "fit", label: "Fit", title: "Rows fill the screen" },
            { v: "paper", label: "Paper", title: `True paper scale: mm/s and ${gainUnit} at 96 CSS px per inch (browser zoom 100%)` },
          ]}
          onChange={(scale) => setDisplay({ scale })}
        />
      )}
      {!p.paper ? (
        <BarSegmented label="Window" value={p.windowSec} options={WINDOWS.map((w) => ({ v: w, label: `${w}s` }))} onChange={p.setWindow} />
      ) : (
        <BarSegmented label="Speed" value={display.speed} options={SPEEDS.map((v) => ({ v, label: `${v}` }))} suffix="mm/s" onChange={(speed) => setDisplay({ speed })} />
      )}
      <BarSegmented label="Gain" value={display.gain} options={withValue(GAINS, display.gain).map((v) => ({ v, label: `${v}` }))} suffix={gainUnit} onChange={(gain) => setDisplay({ gain })} />
      {cfg.grid === "ecg" && (
        <button
          onClick={p.onCalibrate}
          className={cn("rounded-md px-1.5 py-0.5 hover:bg-white/10", p.calibrated ? "text-canvas-foreground/80" : "text-canvas-foreground/55")}
          title={`Calibrate screen for true paper scale (now ${p.pxPerMm.toFixed(3)} px/mm${p.calibrated ? ", calibrated" : ", CSS default"})`}
        >
          {p.calibrated ? "✓ Calibrated" : "Calibrate screen"}
        </button>
      )}
      <span className="h-4 w-px bg-white/10" />
      <BarPick label="HP" value={display.hp} options={withValue(HP, display.hp)} unit="Hz" onChange={(hp) => setDisplay({ hp })} title="High-pass (baseline wander)" />
      <BarPick label="Notch" value={display.notch} options={withValue(NOTCH, display.notch)} unit="Hz" onChange={(notch) => setDisplay({ notch })} title="Mains notch" />
      <BarPick label="LP" value={display.lp} options={withValue(LP, display.lp)} unit="Hz" onChange={(lp) => setDisplay({ lp })} title="Low-pass (muscle noise)" />
      <span
        className={cn("tnum flex items-center gap-1 rounded px-1.5 py-0.5", filtersOn ? "bg-chart-4/20 text-chart-4" : "bg-white/5 text-canvas-foreground/50")}
        title="Display filters are zero-phase and never change the stored time axis or annotations"
      >
        {p.filterPending && <Loader2 className="h-3 w-3 animate-spin" />}
        {filtersOn ? `Filtered ${filterText(filters)}` : "Unfiltered"}
      </span>
      {p.canDetect && (
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={p.onDetect}
            disabled={p.detecting}
            className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-0.5 hover:bg-white/15 disabled:opacity-50"
            title={`Pan–Tompkins R-peak detection on ${cfg.channelNoun} ${detectLead}; results are AI suggestions to review`}
          >
            {p.detecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <HeartPulse className="h-3 w-3" />} Detect beats
          </button>
        </div>
      )}
    </div>
  );
}

export function ToolOptions(p: {
  cfg: StripChartConfig;
  tool: string;
  instantCode: string;
  setInstantCode: (c: string) => void;
  trackCode: string;
  setTrackCode: (r: string) => void;
  wave: string | undefined;
  waveFromLabel: boolean;
  activeLabel: string | null;
  snap: boolean;
  setSnap: (v: boolean) => void;
  marchOut: boolean;
  setMarchOut: (v: boolean) => void;
  dx?: string;
}) {
  const { cfg } = p;
  const noun = cfg.channelNoun;
  const keyHint = (c: Code) => (c.hotkey ? ` (${c.hotkey.replace(/^shift\+(.)$/, (_, k: string) => `Shift+${k.toUpperCase()}`)})` : "");
  return (
    <div className="flex h-8 shrink-0 items-center gap-x-3 overflow-x-auto border-b border-white/10 px-3 text-xs whitespace-nowrap">
      {p.tool === "beat" && cfg.instantCodes.length > 0 && (
        <div className="flex items-center gap-0.5" role="group" aria-label="Beat code">
          <span className="mr-1 text-canvas-foreground/55">Code</span>
          {cfg.instantCodes.map((c) => (
            <button
              key={c.id}
              title={`${c.name ?? c.id}${keyHint(c)}`}
              aria-pressed={c.id === p.instantCode}
              onClick={() => p.setInstantCode(c.id)}
              className={cn("min-w-5 rounded px-1 py-0.5 font-mono font-semibold", c.id === p.instantCode ? "bg-primary text-primary-foreground" : "text-canvas-foreground/75 hover:bg-white/10")}
            >
              {c.id}
            </button>
          ))}
          <span className="ml-2 text-canvas-foreground/45">Click places on the {noun} · Shift-click: all {noun}s</span>
        </div>
      )}
      {p.tool === "rhythm" && (
        <label className="flex items-center gap-1">
          <span className="text-canvas-foreground/55">{cfg.track.label}</span>
          {cfg.trackCodes.length > 0 && (
            <select value={p.trackCode} onChange={(e) => p.setTrackCode(e.target.value)} className="h-6 rounded-md border border-white/15 bg-canvas px-1 text-xs">
              {cfg.trackCodes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                  {r.name ? ` — ${r.name}` : ""}
                </option>
              ))}
            </select>
          )}
          <span className="ml-1 text-canvas-foreground/45">Drag on the {cfg.track.label.toLowerCase()} track (or any {noun})</span>
        </label>
      )}
      {p.tool === "wave" && (
        <span className="text-canvas-foreground/60">
          Wave <b className="text-canvas-foreground">{p.wave ?? "—"}</b>{" "}
          {p.waveFromLabel ? `from label “${p.activeLabel}”` : cfg.waves.length ? `(pick ${cfg.waves.map((w) => w.label).join(" / ")} label to change)` : ""} · drag onset → offset · Shift: all {noun}s
        </span>
      )}
      {p.tool === "interval" && (
        <span className="text-canvas-foreground/60">
          Drag across a {noun} · Shift-drag: all {noun}s
        </span>
      )}
      {p.tool === "caliper" && (
        <>
          <span className="text-canvas-foreground/60">Drag to measure{cfg.ecg ? " · Alt-drag Q onset → T end for QT/QTc" : ""} · Esc clears</span>
          <BarToggle on={p.marchOut} onChange={p.setMarchOut} label="March-out" />
        </>
      )}
      {(p.tool === "beat" || p.tool === "select") && <BarToggle on={p.snap} onChange={p.setSnap} label="Snap to peak" />}
      {p.dx && <span className="ml-auto truncate text-canvas-foreground/45">Source Dx {p.dx}</span>}
    </div>
  );
}

export function ChannelMenu(p: { noun: string; lead: string; x: number; y: number; focused: boolean; gain?: number; onFocus: () => void; onGain: (g: number | undefined) => void; onClose: () => void }) {
  const Noun = p.noun.charAt(0).toUpperCase() + p.noun.slice(1);
  return (
    <div
      className="absolute z-20 w-44 rounded-md border border-white/15 bg-canvas p-1 text-xs shadow-lg"
      style={{ left: Math.max(4, p.x), top: p.y + 8 }}
      onPointerDown={(e) => e.stopPropagation()}
      role="menu"
      aria-label={`${Noun} ${p.lead}`}
    >
      <div className="px-2 py-1 font-semibold">
        {Noun} {p.lead}
      </div>
      <button role="menuitem" onClick={p.onFocus} className="w-full rounded px-2 py-1 text-left hover:bg-white/10">
        {p.focused ? `Show all ${p.noun}s` : `Focus this ${p.noun}`}
      </button>
      <div className="px-2 pt-1.5 pb-0.5 text-canvas-foreground/55">Gain (this {p.noun})</div>
      <div className="flex gap-0.5 px-1 pb-1">
        {[undefined, 5, 10, 20].map((g) => (
          <button
            key={String(g)}
            role="menuitemradio"
            aria-checked={p.gain === g}
            onClick={() => p.onGain(g)}
            className={cn("tnum flex-1 rounded px-1 py-0.5", p.gain === g ? "bg-primary text-primary-foreground" : "hover:bg-white/10")}
          >
            {g ?? "Auto"}
          </button>
        ))}
      </div>
      <button onClick={p.onClose} className="sr-only">
        Close
      </button>
    </div>
  );
}
