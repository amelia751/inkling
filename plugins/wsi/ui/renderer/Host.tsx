import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FlipHorizontalIcon, FitIcon, RotateLeftIcon, RotateRightIcon, TagIcon, UploadIcon, ZoomInIcon, ZoomOutIcon } from "@studio/ui/icons";
import { regionOf } from "@studio/renderers/overlay2d/regions";
import { CanvasNotice } from "@studio/renderers/viewport-chrome/CanvasNotice";
import { cn } from "@studio/ui/utils";
import { labelNames } from "@studio/contracts/environment";
import { derivativeNotice } from "@studio/contracts/types";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import { useRuntime } from "@studio/plugin-ui-sdk/runtime";
import { fromGeoJSON } from "../io";
import { WSI, type WsiConfig } from "../manifest";
import { INITIAL_UI, WsiController, type UiState } from "./controller";
import { NEUTRAL_ADJUST, type Adjustments } from "./wand";
import { ns } from "@studio/contracts/naming";
import { execute, markFirstFrame, useCommands, useHost } from "@studio/plugin-ui-sdk";

const MAGNIFICATIONS = [1.25, 5, 10, 20, 40];
const fmtMag = (m: number) => (m < 10 ? m.toFixed(1) : String(Math.round(m)));
const IMPORT = `${WSI}.commands.importGeoJSON`;

/**
 * `studio.wsi.renderers.osd`: the thin React host around WsiController. It owns the
 * stage element, the magnification / rotation bar and the GeoJSON file input, publishes
 * `mpp` to the runtime and binds keys through commands; colour adjustments arrive from
 * the `adjust` viewport-bar panel through the runtime (`adjust`).
 */
export function OsdRenderer(props: RendererProps) {
  // todo18 D4: an uploaded SVS/NDPI/MRXS opens from its DZI once the worker tiled it.
  const asset = props.item.assets.find((a) => a.path.endsWith(".dzi")) ?? props.item.assets[0];
  const notice = asset ? derivativeNotice(asset) : null;
  if (notice) {
    return (
      <div className="relative h-full w-full" data-testid="wsi-derivative-notice">
        <CanvasNotice loading={notice.busy}>{notice.text}</CanvasNotice>
      </div>
    );
  }
  return <OsdHost {...props} />;
}

function OsdHost({ project, item, config, runtime }: RendererProps) {
  const cfg = config as WsiConfig;
  const asset = item.assets.find((a) => a.path.endsWith(".dzi")) ?? item.assets[0];
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<WsiController | null>(null);
  const [ui, setUi] = useState<UiState>(INITIAL_UI);
  useEffect(() => {
    if (ui.ready) markFirstFrame({ renderer: "osd", itemId: item.id });
  }, [ui.ready, item.id]);
  const adjust = useRuntime<Adjustments>(item.id, "adjust") ?? NEUTRAL_ADJUST;
  const gammaId = `gamma-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const labels = labelNames(project.labels);
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const objective = cfg.objective ?? (Number(asset.magnification) || 40);
  const mpp = cfg.mpp ?? asset.mpp ?? null;

  useEffect(() => runtime.publish("mpp", mpp), [runtime, mpp]);

  useEffect(() => {
    if (!stageRef.current || !hostRef.current) return;
    setUi(INITIAL_UI);
    const ctrl = new WsiController({
      stage: stageRef.current,
      host: hostRef.current,
      item,
      asset,
      labels: () => labelsRef.current,
      mpp,
      objective,
      showNavigator: cfg.showNavigator !== false,
      onUi: setUi,
    });
    ctrlRef.current = ctrl;
    if (import.meta.env.DEV) (window as unknown as { __pathology?: WsiController }).__pathology = ctrl;
    return () => {
      ctrl.destroy();
      ctrlRef.current = null;
    };
    // Recreate only for a new slide (or a new scale / navigator setting); labels are read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.path, item.id, mpp, objective, cfg.showNavigator]);

  useEffect(() => ctrlRef.current?.setAdjust(adjust, gammaId), [adjust, gammaId, ui.ready]);

  const importer = useImport(item.id, labels);

  useCommands(
    {
      cancelShape: () => ctrlRef.current?.engine.cancelShape() ?? false,
      finishShape: () => ctrlRef.current?.engine.finishShape() ?? false,
      removeLastVertex: () => ctrlRef.current?.engine.removeLastVertex() ?? false,
      holdToPan: () => ctrlRef.current?.engine.holdToPan() ?? false,
      toggleClassNames: () => {
        ctrlRef.current?.toggleNames();
      },
      rotateView: () => {
        ctrlRef.current?.rotate(90);
      },
      importGeoJSON: () => {
        importer.open();
      },
    },
    { scope: [WSI, ns("core")] },
  );

  // Status bar: dimensions, magnification, scale, object counts.
  const annotations = useHost((s) => s.annotations);
  const counts = useMemo(() => {
    let regions = 0, points = 0;
    for (const a of annotations) {
      if (a.itemId !== item.id) continue;
      if (a.geometry.type === "keypoint") points++;
      else if (regionOf(a.geometry)) regions++;
    }
    return { regions, points };
  }, [annotations, item.id]);
  const setViewerStatus = useHost((s) => s.setViewerStatus);
  const magText = ui.mag ? `${fmtMag(ui.mag)}× of ${objective}×` : "…";
  useEffect(() => {
    setViewerStatus(
      [
        `${asset.width?.toLocaleString()}×${asset.height?.toLocaleString()} px`,
        magText,
        mpp ? `${mpp.toFixed(3)} µm/px` : "µm/px unknown",
        ui.rotation || ui.flipped ? `${ui.rotation}°${ui.flipped ? " flipped" : ""}` : null,
        `${counts.regions} regions`,
        `${counts.points} points`,
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
        <button className={btn} aria-label="Zoom in" title="Zoom in" onClick={() => ctrl()?.zoomBy(1.5)}><ZoomInIcon className="h-3.5 w-3.5" /></button>
        <button className={btn} aria-label="Zoom out" title="Zoom out" onClick={() => ctrl()?.zoomBy(1 / 1.5)}><ZoomOutIcon className="h-3.5 w-3.5" /></button>
        <button className={btn} aria-label="Fit slide" title="Fit slide" onClick={() => ctrl()?.goHome()}><FitIcon className="h-3.5 w-3.5" /></button>
        <span className="mx-0.5 h-4 w-px bg-white/20" />
        <button className={btn} aria-label="Rotate left" title="Rotate 90° left" onClick={() => ctrl()?.rotate(-90)}><RotateLeftIcon className="h-3.5 w-3.5" /></button>
        <button className={btn} aria-label="Rotate right" title="Rotate 90° right (Shift+R)" onClick={() => ctrl()?.rotate(90)}><RotateRightIcon className="h-3.5 w-3.5" /></button>
        <button className={cn(btn, ui.flipped && "bg-white/20")} aria-label="Flip horizontally" aria-pressed={ui.flipped} title="Flip horizontally" onClick={() => ctrl()?.toggleFlip()}><FlipHorizontalIcon className="h-3.5 w-3.5" /></button>
        <span className="mx-0.5 h-4 w-px bg-white/20" />
        <button className={cn(btn, ui.showNames && "bg-white/20")} aria-label="Show names" aria-pressed={ui.showNames} title="Show names (N)" onClick={() => ctrl()?.toggleNames()}><TagIcon className="h-3.5 w-3.5" /></button>
        <button className={btn} aria-label="Import GeoJSON" title="Import QuPath GeoJSON" onClick={() => execute(IMPORT)}>
          <UploadIcon className="h-3.5 w-3.5" />
        </button>
        {importer.input}
        {importer.message && <span className="px-1 text-white/80">{importer.message}</span>}
      </div>

      {ui.hint && <div className="pointer-events-none absolute left-1/2 top-14 -translate-x-1/2 rounded-md bg-black/65 px-2 py-1 text-xs text-white">{ui.hint}</div>}
      {!ui.ready && !ui.error && <CanvasNotice loading>Loading slide tiles</CanvasNotice>}
      {ui.error && <CanvasNotice>{ui.error}</CanvasNotice>}
    </div>
  );
}

/** `studio.wsi.commands.importGeoJSON`: a hidden file input; one undo step adds every imported object. */
function useImport(itemId: string, labels: string[]) {
  const ref = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(t);
  }, [message]);
  const onFile = async (file: File) => {
    try {
      const s = useHost.getState();
      const { annotations, skipped } = fromGeoJSON(await file.text(), itemId, labels, s.activeLabel ?? labels[0] ?? "region");
      s.addMany(annotations);
      setMessage(`Imported ${annotations.length} objects${skipped ? `, skipped ${skipped}` : ""}`);
    } catch (err) {
      setMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const input = (
    <input
      ref={ref}
      type="file"
      accept=".geojson,.json,application/geo+json,application/json"
      className="hidden"
      onChange={(e) => {
        const f = e.target.files?.[0];
        if (f) void onFile(f);
        e.target.value = "";
      }}
    />
  );
  return { input, message, open: () => ref.current?.click() };
}
