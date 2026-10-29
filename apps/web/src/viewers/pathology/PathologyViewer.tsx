import { labelNames } from "@/platform/environment";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FlipHorizontalIcon as FlipHorizontal2, FitIcon as Maximize2, RotateLeftIcon as RotateCcw, RotateRightIcon as RotateCw, SettingsIcon as SlidersHorizontal, TagIcon as Tag, UploadIcon as Upload, ZoomInIcon as ZoomIn, ZoomOutIcon as ZoomOut } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { useCommands } from "@/lib/hotkeys";
import { labelColor } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useStudio } from "@/stores/studio";
import { CanvasNotice } from "@/viewers/shared/CanvasNotice";
import type { ViewerProps } from "@/viewers/ViewerAdapter";
import { PathologyController, type UiState } from "./controller";
import { fromGeoJSON } from "./io";
import { countMarks } from "./measure";
import { regionArea, regionOf } from "./regions";
import { NEUTRAL_ADJUST, type Adjustments } from "./wand";

const MAGNIFICATIONS = [1.25, 5, 10, 20, 40];
const INITIAL_UI: UiState = { ready: false, error: null, mag: 0, rotation: 0, flipped: false, showNames: false, busy: false, hint: null, drawer: "" };

const fmtMag = (m: number) => (m < 10 ? m.toFixed(1) : String(Math.round(m)));

export function PathologyViewer({ project, item }: ViewerProps) {
  const asset = item.assets.find((a) => a.path.endsWith(".dzi")) ?? item.assets[0];
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<PathologyController | null>(null);
  const [ui, setUi] = useState<UiState>(INITIAL_UI);
  const [adjust, setAdjust] = useState<Adjustments>(NEUTRAL_ADJUST);
  const [tolerance, setTolerance] = useState(28);
  const gammaId = `gamma-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const tool = useStudio((s) => s.tool);
  const labels = labelNames(project.labels);
  const objective = Number(asset.magnification) || 40;
  const mpp = asset.mpp ?? null;

  useEffect(() => {
    if (!stageRef.current || !hostRef.current) return;
    setUi(INITIAL_UI);
    const ctrl = new PathologyController(stageRef.current, hostRef.current, project, item, asset, setUi);
    ctrlRef.current = ctrl;
    if (import.meta.env.DEV) (window as unknown as { __pathology?: PathologyController }).__pathology = ctrl;
    return () => {
      ctrl.destroy();
      ctrlRef.current = null;
    };
    // The controller reads labels/item through its own fields; recreate only for a new slide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.path, item.id]);

  useEffect(() => ctrlRef.current?.setAdjust(adjust, gammaId), [adjust, gammaId, ui.ready]);
  useEffect(() => {
    if (ctrlRef.current) ctrlRef.current.wandTolerance = tolerance;
  }, [tolerance, ui.ready]);

  useCommands(
    {
    cancelShape: () => ctrlRef.current?.cancelShape() ?? false,
    finishShape: () => ctrlRef.current?.finishDraft() ?? false,
    removeLastVertex: () => ctrlRef.current?.removeLastVertex() ?? false,
    toggleClassNames: () => {
      ctrlRef.current?.toggleNames();
    },
    rotateView: () => {
      ctrlRef.current?.rotate(90);
    },
    holdToPan: () => ctrlRef.current?.holdToPan() ?? false,
    },
    { scope: ["inkling.wsi", "inkling.core"] },
  );

  // Status bar: dimensions, magnification, scale, object counts.
  const annotations = useStudio((s) => s.annotations);
  const counts = useMemo(() => {
    let regions = 0, marks = 0;
    for (const a of annotations) {
      if (a.itemId !== item.id) continue;
      if (a.geometry.type === "mark") marks++;
      else if (regionOf(a.geometry)) regions++;
    }
    return { regions, marks };
  }, [annotations, item.id]);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);
  const magText = ui.mag ? `${fmtMag(ui.mag)}× of ${objective}×` : "…";
  useEffect(() => {
    setViewerStatus(
      [
        `${asset.width?.toLocaleString()}×${asset.height?.toLocaleString()} px`,
        magText,
        mpp ? `${mpp.toFixed(3)} µm/px` : "µm/px unknown",
        ui.rotation || ui.flipped ? `${ui.rotation}°${ui.flipped ? " flipped" : ""}` : null,
        `${counts.regions} regions`,
        `${counts.marks} points`,
      ]
        .filter(Boolean)
        .join(" · "),
    );
  }, [asset.width, asset.height, magText, mpp, ui.rotation, ui.flipped, counts, setViewerStatus]);

  const ctrl = () => ctrlRef.current;
  const btn = "rounded-md p-1 hover:bg-white/15 disabled:opacity-40";

  return (
    <div ref={stageRef} className="relative h-full w-full overflow-hidden bg-canvas text-canvas-foreground" data-testid="wsi-viewer">
      <div ref={hostRef} className="absolute inset-0" />
      <svg width="0" height="0" className="absolute" aria-hidden>
        <filter id={gammaId} colorInterpolationFilters="sRGB">
          <feComponentTransfer>
            <feFuncR type="gamma" exponent={1 / adjust.gamma} />
            <feFuncG type="gamma" exponent={1 / adjust.gamma} />
            <feFuncB type="gamma" exponent={1 / adjust.gamma} />
          </feComponentTransfer>
        </filter>
      </svg>

      <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1 rounded-lg bg-black/55 p-1 text-xs text-white backdrop-blur">
        {MAGNIFICATIONS.filter((m) => m <= objective).map((m) => (
          <button
            key={m}
            onClick={() => ctrl()?.zoomToMagnification(m)}
            className={cn("tnum rounded-md px-2 py-0.5 transition-colors", ui.mag && Math.abs(ui.mag - m) / m < 0.08 ? "bg-primary text-primary-foreground" : "hover:bg-white/15")}
          >
            {m}×
          </button>
        ))}
        <span className="mx-0.5 h-4 w-px bg-white/20" />
        <button className={btn} aria-label="Zoom in" title="Zoom in" onClick={() => ctrl()?.zoomBy(1.5)}><ZoomIn className="h-3.5 w-3.5" /></button>
        <button className={btn} aria-label="Zoom out" title="Zoom out" onClick={() => ctrl()?.zoomBy(1 / 1.5)}><ZoomOut className="h-3.5 w-3.5" /></button>
        <button className={btn} aria-label="Fit slide" title="Fit slide" onClick={() => ctrl()?.goHome()}><Maximize2 className="h-3.5 w-3.5" /></button>
        <span className="mx-0.5 h-4 w-px bg-white/20" />
        <button className={btn} aria-label="Rotate left" title="Rotate 90° left" onClick={() => ctrl()?.rotate(-90)}><RotateCcw className="h-3.5 w-3.5" /></button>
        <button className={btn} aria-label="Rotate right" title="Rotate 90° right (Shift+R)" onClick={() => ctrl()?.rotate(90)}><RotateCw className="h-3.5 w-3.5" /></button>
        <button className={cn(btn, ui.flipped && "bg-white/20")} aria-label="Flip horizontally" aria-pressed={ui.flipped} title="Flip horizontally" onClick={() => ctrl()?.toggleFlip()}><FlipHorizontal2 className="h-3.5 w-3.5" /></button>
        <span className="mx-0.5 h-4 w-px bg-white/20" />
        <button className={cn(btn, ui.showNames && "bg-white/20")} aria-label="Show names" aria-pressed={ui.showNames} title="Show names (N)" onClick={() => ctrl()?.toggleNames()}><Tag className="h-3.5 w-3.5" /></button>
        <AdjustPopover adjust={adjust} onChange={setAdjust} />
        <ImportButton itemId={item.id} labels={labels} />
        {tool === "wand" && (
          <div className="ml-1 flex items-center gap-2 pr-1" title="Colour tolerance of the wand. Shift-click adds to the selected region, Alt-click subtracts">
            <span className="opacity-80">Tolerance</span>
            <Slider value={[tolerance]} min={4} max={100} step={1} onValueChange={([v]) => setTolerance(v)} className="w-20" aria-label="Wand tolerance" />
            <span className="tnum w-6">{tolerance}</span>
          </div>
        )}
      </div>

      <CountsPanel itemId={item.id} labels={labels} mpp={mpp} show={tool === "mark" || counts.marks > 0} />

      {ui.hint && <div className="pointer-events-none absolute left-1/2 top-14 -translate-x-1/2 rounded-md bg-black/65 px-2 py-1 text-xs text-white">{ui.hint}</div>}
      {!ui.ready && !ui.error && <CanvasNotice>Loading slide tiles…</CanvasNotice>}
      {ui.error && <CanvasNotice>{ui.error}</CanvasNotice>}
    </div>
  );
}

function AdjustPopover({ adjust, onChange }: { adjust: Adjustments; onChange: (a: Adjustments) => void }) {
  const rows: { key: keyof Adjustments; label: string; min: number; max: number }[] = [
    { key: "brightness", label: "Brightness", min: 0.3, max: 2 },
    { key: "contrast", label: "Contrast", min: 0.3, max: 3 },
    { key: "gamma", label: "Gamma", min: 0.3, max: 3 },
    { key: "saturation", label: "Saturation", min: 0, max: 3 },
  ];
  const changed = (Object.keys(adjust) as (keyof Adjustments)[]).some((k) => adjust[k] !== 1);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn("rounded-md p-1 hover:bg-white/15", changed && "bg-white/20")} aria-label="Image adjustments" title="Brightness, contrast, gamma, saturation">
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-3 p-3 text-xs">
        {rows.map((r) => (
          <div key={r.key} className="space-y-1.5">
            <div className="flex justify-between">
              <span>{r.label}</span>
              <span className="tnum text-muted-foreground">{adjust[r.key].toFixed(2)}</span>
            </div>
            <Slider value={[adjust[r.key]]} min={r.min} max={r.max} step={0.01} onValueChange={([v]) => onChange({ ...adjust, [r.key]: v })} aria-label={r.label} />
          </div>
        ))}
        <button className="w-full rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50" disabled={!changed} onClick={() => onChange(NEUTRAL_ADJUST)}>
          Reset
        </button>
        <p className="text-muted-foreground">Display only; the wand samples the adjusted colours.</p>
      </PopoverContent>
    </Popover>
  );
}

function ImportButton({ itemId, labels }: { itemId: string; labels: string[] }) {
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);
  const onFile = async (file: File) => {
    try {
      const s = useStudio.getState();
      const { annotations, skipped } = fromGeoJSON(await file.text(), itemId, labels, s.activeLabel ?? labels[0] ?? "region");
      s.addMany(annotations);
      setMsg(`Imported ${annotations.length} objects${skipped ? `, skipped ${skipped}` : ""}`);
    } catch (err) {
      setMsg(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return (
    <>
      <button className="rounded-md p-1 hover:bg-white/15" aria-label="Import GeoJSON" title="Import QuPath GeoJSON" onClick={() => input.current?.click()}>
        <Upload className="h-3.5 w-3.5" />
      </button>
      <input
        ref={input}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
          e.target.value = "";
        }}
      />
      {msg && <span className="px-1 text-white/80">{msg}</span>}
    </>
  );
}

/** QuPath-style point counts per class; inside the selected region with density when one is selected. */
function CountsPanel({ itemId, labels, mpp, show }: { itemId: string; labels: string[]; mpp: number | null; show: boolean }) {
  const annotations = useStudio((s) => s.annotations);
  const selectedId = useStudio((s) => s.selectedId);
  const selected = annotations.find((a) => a.id === selectedId && a.itemId === itemId);
  const geometry = selected?.geometry;
  const region = useMemo(() => (geometry ? regionOf(geometry) : null), [geometry]);
  const all = useMemo(() => (show ? countMarks(annotations, itemId, null) : new Map<string, number>()), [annotations, itemId, show]);
  const inside = useMemo(() => (region ? countMarks(annotations, itemId, region) : null), [annotations, itemId, region]);
  const total = (m: Map<string, number>) => [...m.values()].reduce((s, n) => s + n, 0);
  if (!show && !(inside && total(inside))) return null;
  const areaMm2 = region && mpp ? regionArea(region) * mpp * mpp * 1e-6 : 0;
  const classes = [...new Set([...labels, ...all.keys()])];
  return (
    <div className="absolute right-3 top-3 w-52 rounded-lg bg-black/60 p-2 text-xs text-white backdrop-blur" data-testid="point-counts">
      <div className="mb-1 flex justify-between font-medium">
        <span>Points</span>
        <span className="tnum">{total(all)}</span>
      </div>
      {classes.map((l) => (
        <div key={l} className="flex items-center justify-between py-0.5">
          <span className="flex items-center gap-1.5 capitalize">
            <span className="h-2 w-2 rounded-full" style={{ background: labelColor(labels, l) }} />
            {l}
          </span>
          <span className="tnum">{all.get(l) ?? 0}</span>
        </div>
      ))}
      {inside && selected && (
        <div className="mt-1.5 border-t border-white/15 pt-1.5">
          <div className="mb-0.5 flex justify-between font-medium">
            <span className="truncate">In selected {selected.label}</span>
            <span className="tnum">{total(inside)}</span>
          </div>
          {[...inside].map(([l, n]) => (
            <div key={l} className="flex justify-between py-0.5">
              <span className="capitalize">{l}</span>
              <span className="tnum">
                {n}
                {areaMm2 > 0 && <span className="ml-1 text-white/60">({Math.round(n / areaMm2).toLocaleString()}/mm²)</span>}
              </span>
            </div>
          ))}
          {areaMm2 > 0 && (
            <div className="flex justify-between pt-0.5 text-white/70">
              <span>Density</span>
              <span className="tnum">{Math.round(total(inside) / areaMm2).toLocaleString()} /mm²</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
