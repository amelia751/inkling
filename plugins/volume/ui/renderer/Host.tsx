import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loupe } from "@studio/studio-renderers/cornerstone/interactions";
import { CanvasNotice } from "@studio/studio-renderers/viewport-chrome/CanvasNotice";
import { CornerText, OrientationMarkers, TextPrompt, type PromptRequest } from "@studio/studio-renderers/viewport-chrome/bar";
import { formatWL } from "@studio/studio-renderers/cornerstone/viewControls";
import { labelNames } from "@studio/plugin-contracts/environment";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import { cn } from "@studio/studio-ui/utils";
import type { Plane } from "@studio/plugin-contracts/types";
import { VOLUME_COMMANDS as C } from "../commands";
import { cellsFor, gridClass, mprConfig, type Cell, type Layout } from "../config";
import { initialSource, referenceAsset, volumeSources } from "../dataKind";
import { MprEngine, type EngineContext, type WandMode } from "./MprEngine";
import { ViewBar } from "./ViewBar";
import { brushSizeOf, execute, toolOption, useCommands, useHost } from "@studio/plugin-ui-sdk";

/**
 * React host of the MPR renderer: owns the UI state (sequence, layout, view toggles), mounts
 * the cells and drives MprEngine. Keys go through commands declared in the manifests
 * (inkling.volume, inkling.cornerstone, inkling.core); the bar's buttons run the same commands.
 */
export function MprRenderer({ project, item, config, runtime }: RendererProps) {
  const cfg = useMemo(() => mprConfig(config), [config]);
  const labels = labelNames(project.labels);
  const sequences = useMemo(() => volumeSources(item.assets), [item.assets]);
  const segAsset = referenceAsset(item.assets);
  const [sequence, setSequence] = useState(() => initialSource(sequences, cfg.sequence)?.key);
  const [layout, setLayout] = useState<Layout>(cfg.layout);
  const [single, setSingle] = useState<Plane>(cfg.plane);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [viewReady, setViewReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRef, setShowRef] = useState(true);
  const [refReady, setRefReady] = useState(false);
  const [mip, setMip] = useState(false);
  const [sphere, setSphere] = useState(false);
  const [magnify, setMagnify] = useState(false);
  const [panning, setPanning] = useState(false);
  const [wandMode, setWandMode] = useState<WandMode>("flood");
  const [colormap, setColormapName] = useState("Grayscale");
  const [linear, setLinear] = useState(true);
  const [activeCell, setActiveCell] = useState<Plane>(cfg.plane);
  const [busy, setBusy] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [tick, setTick] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const tool = useHost((s) => s.tool);
  const brushSize = useHost(brushSizeOf);
  const brushThreshold = useHost((s) => toolOption(s, "brush", "threshold", false));
  const activeLabel = useHost((s) => s.activeLabel);
  const setViewerStatus = useHost((s) => s.setViewerStatus);
  const cells = cellsFor(layout, single);

  const ctx = useRef<EngineContext>({ project, item, labels, runtime });
  ctx.current = { project, item, labels, runtime };
  const raf = useRef(0);
  const refresh = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      setTick((t) => t + 1);
    });
  }, []);
  const [engine] = useState(
    () =>
      new MprEngine(() => ctx.current, {
        status: (s, message) => {
          setStatus(s);
          if (message) setError(message);
        },
        viewReady: setViewReady,
        refReady: setRefReady,
        refresh,
        activeCell: setActiveCell,
        busy: setBusy,
        viewerStatus: (text) => useHost.getState().setViewerStatus(text),
        promptText: (initial) => new Promise<string | null>((resolve) => setPrompt({ initial, resolve })),
      }),
  );
  engine.activePlane = activeCell;
  engine.wandMode = wandMode;

  // Session per subject (the shell remounts the renderer per item); the sequence only seeds the label grid.
  useEffect(
    () => engine.open(initialSource(sequences, sequence) ?? sequences[0], segAsset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // View per layout / sequence. Colormap, interpolation, MIP and reference visibility apply live; they only seed a rebuild.
  useEffect(() => {
    if (status !== "ready") return;
    const source = sequences.find((a) => a.key === sequence) ?? sequences[0];
    return engine.build({ layout, cells, source, colormap, linear, mip, showRef, preset3d: cfg.preset3d });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, layout, single, sequence]);

  useEffect(() => {
    if (viewReady) engine.bindTool(tool, panning, cells);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, viewReady, panning]);

  useEffect(() => {
    const host = gridRef.current;
    if (!viewReady || !host) return;
    return engine.attachSelectToggle(host, cells);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewReady, layout, single]);

  useEffect(() => {
    if (viewReady) engine.applyBrush(brushSize, brushThreshold, sphere);
  }, [engine, brushSize, brushThreshold, viewReady, sphere, tick, activeCell]);

  useEffect(() => {
    if (viewReady) engine.setActiveLabel(activeLabel);
  }, [engine, activeLabel, viewReady, labels.join("\n")]);

  useEffect(() => {
    if (viewReady) engine.setReferenceVisible(showRef);
  }, [engine, showRef, viewReady, refReady]);

  useEffect(() => {
    if (!viewReady || tool !== "wand" || panning) return;
    return engine.attachWand(cells);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, viewReady, labels.join("\n"), panning]);

  // Space held: Pan as the primary tool, whatever the active tool (released on keyup / blur).
  useEffect(() => {
    if (!panning) return;
    const release = (e: KeyboardEvent | FocusEvent) => {
      if (e instanceof KeyboardEvent && e.code !== "Space") return;
      setPanning(false);
    };
    window.addEventListener("keyup", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", release);
    };
  }, [panning]);

  // ---------------------------------------------------------------- commands (keys come from the manifests)
  const ready = () => viewReady && engine.ready;
  const toggleMip = () => {
    const next = !mip;
    setMip(next);
    engine.setMip(next);
  };
  useCommands({
    [C.stepSlice]: (e) => (ready() ? engine.scroll(e.key === "ArrowUp" ? -1 : 1) : false),
    [C.firstLastSlice]: (e) => (ready() ? engine.jump(e.key === "End") : false),
    [C.fitView]: () => (ready() ? engine.resetAll() : false),
    [C.cancel]: () => ready() && engine.cancelManipulations(),
    [C.interpolate]: () => engine.interpolate(),
    [C.removeIslands]: () => engine.removeIslands(),
    [C.smartFill]: () => setWandMode("smart"),
    [C.similarFill]: () => setWandMode("flood"),
    [C.invert]: () => (ready() ? engine.invert() : false),
    [C.flipH]: () => (ready() ? engine.flip("h") : false),
    [C.flipV]: () => (ready() ? engine.flip("v") : false),
    [C.rotateRight]: () => (ready() ? engine.rotate(90) : false),
    [C.rotateLeft]: () => (ready() ? engine.rotate(-90) : false),
    [C.magnifier]: () => (viewReady ? setMagnify((m) => !m) : false),
    [C.holdToPan]: () => (viewReady ? setPanning(true) : false),
  });

  // ---------------------------------------------------------------- status line + runtime
  const lastState = useRef("");
  useEffect(() => {
    if (!viewReady) return;
    const slices: Partial<Record<Plane, number>> = {};
    const parts = (["axial", "sagittal", "coronal"] as Plane[])
      .map((p) => {
        const i = engine.cellInfo(p);
        if (!i) return null;
        slices[p] = i.slice - 1;
        return `${p[0].toUpperCase()}${p.slice(1)} ${i.slice}/${i.total}`;
      })
      .filter(Boolean);
    const r = engine.readout;
    setViewerStatus(
      [...parts, `${engine.spacingText()} mm`, formatWL(engine.activeVoi()), r ? `[${r.ijk.join(", ")}] = ${Math.round(r.value * 100) / 100}` : ""].filter(Boolean).join(" · "),
    );
    const state = { layout, sequence, activePlane: activeCell, slices };
    const key = JSON.stringify(state);
    if (key !== lastState.current) {
      lastState.current = key;
      runtime.publish("viewportState", state);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, viewReady]);

  if (status === "error") {
    return (
      <div className="relative h-full w-full bg-canvas">
        <CanvasNotice>{error}</CanvasNotice>
      </div>
    );
  }

  const onWindow = (v: string) => {
    if (v === "auto") engine.autoVoi();
    else if (v === "full") engine.fullVoi();
    else engine.ctPreset(v);
  };

  return (
    <div className="flex h-full w-full flex-col bg-canvas text-canvas-foreground">
      <ViewBar
        run={(id) => void execute(id)}
        sequences={sequences}
        sequence={sequence}
        onSequence={setSequence}
        modality={engine.modality}
        layout={layout}
        layouts={cfg.layouts}
        onLayout={setLayout}
        single={single}
        onSingle={(p) => {
          setSingle(p);
          engine.activePlane = p;
          setActiveCell(p);
        }}
        modalityIsCT={engine.modality === "CT"}
        onWindow={onWindow}
        inverted={engine.isInverted()}
        colormap={colormap}
        onColormap={(name) => {
          setColormapName(name);
          engine.setColormap(name);
        }}
        linear={linear}
        onLinear={() => {
          setLinear(!linear);
          engine.setInterpolation(!linear);
        }}
        mip={mip}
        onMip={toggleMip}
        hasReference={!!segAsset}
        showRef={showRef}
        refReady={refReady}
        onShowRef={() => setShowRef((v) => !v)}
        onCopyReference={() => engine.copyReference()}
        magnify={magnify}
        tool={tool}
        wandMode={wandMode}
        sphere={sphere}
        onSphere={() => setSphere((v) => !v)}
        activeCell={activeCell}
        busy={busy}
      />
      <div ref={gridRef} className={cn("relative grid min-h-0 flex-1 gap-px bg-white/10", gridClass(layout))}>
        {cells.map((cell, i) => (
          <CellView
            key={`${layout}-${cell}`}
            cell={cell}
            engine={engine}
            setElement={(el) => engine.setElement(cell, el)}
            className={cn(layout === "main" && i === 0 && "row-span-2", cell !== "3d" && cell === activeCell && cells.length > 1 && "outline outline-1 -outline-offset-1 outline-primary/60")}
            viewReady={viewReady}
            preset3d={cfg.preset3d}
          />
        ))}
        <TextPrompt request={prompt} onDone={() => setPrompt(null)} />
        <Loupe root={gridRef.current} enabled={magnify && viewReady} />
        {(status === "loading" || !viewReady) && <CanvasNotice>Decoding volume…</CanvasNotice>}
      </div>
    </div>
  );
}

/** One viewport cell: the Cornerstone element plus its corner overlays (re-rendered with the host on every refresh). */
function CellView({ cell, engine, setElement, className, viewReady, preset3d }: { cell: Cell; engine: MprEngine; setElement: (el: HTMLDivElement | null) => void; className?: string; viewReady: boolean; preset3d: string }) {
  const inf = viewReady ? engine.cellInfo(cell) : null;
  const r = engine.readout?.cell === cell ? engine.readout : null;
  return (
    <div className={cn("relative min-h-0 min-w-0 bg-black", className)}>
      <div ref={setElement} className="absolute inset-0" onContextMenu={(e) => e.preventDefault()} data-testid={cell === "3d" ? "volume-3d" : `plane-${cell}`} />
      {inf && (
        <>
          <OrientationMarkers {...inf.markers} />
          <CornerText
            tl={<div className="uppercase tracking-wide">{cell}</div>}
            tr={
              <div>
                {inf.slice} / {inf.total}
              </div>
            }
            bl={
              <>
                <div>{formatWL(inf.voi)}</div>
                {r && (
                  <div>
                    [{r.ijk.join(", ")}] = {Math.round(r.value * 100) / 100}
                  </div>
                )}
              </>
            }
            br={<div>Zoom {inf.zoom}%</div>}
          />
        </>
      )}
      {cell === "3d" && viewReady && <CornerText tl={<div className="uppercase tracking-wide">{preset3d === "MR-Default" ? "3D · MR preset" : `3D · ${preset3d}`}</div>} br={<div>Drag to rotate</div>} />}
    </div>
  );
}
