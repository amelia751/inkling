import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatWL } from "@/kits/cornerstone/viewControls";
import { Loupe } from "@/kits/cornerstone/interactions";
import { CornerText, TextPrompt, type PromptRequest } from "@/kits/viewport-chrome/bar";
import { CanvasNotice } from "@/kits/viewport-chrome/CanvasNotice";
import { useCommands } from "@/platform/commands";
import type { RendererProps } from "@/platform/module";
import { brushSizeOf, toolOption, useStudio } from "@/stores/studio";
import { StackConfigSchema, VIEW_CONTROLS, VIEW_STATE, type ViewControls, type ViewState } from "../view";
import { CornerstoneStackEngine } from "./CornerstoneStackEngine";
import { useHoldToPan } from "./holdToPan";

const SCOPES = ["inkling.image2d", "inkling.cornerstone", "inkling.core"];

/**
 * Thin React host for `inkling.image2d.renderers.cornerstone-stack`: mounts the engine,
 * forwards the studio tool / brush / label to it, binds its commands and publishes the
 * view state + actions the viewport-bar panel (`panels/viewControls.tsx`) renders.
 */
export default function CornerstoneStackHost({ project, item, config: raw, runtime }: RendererProps) {
  const config = useMemo(() => StackConfigSchema.parse(raw ?? {}), [raw]);
  const elementRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CornerstoneStackEngine | null>(null);
  const [tick, setTick] = useState(0);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [magnify, setMagnify] = useState(false);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);
  const tool = useStudio((s) => s.tool);
  const brushSize = useStudio(brushSizeOf);
  const brushThreshold = useStudio((s) => toolOption(s, "brush", "threshold", false));
  const activeLabel = useStudio((s) => s.activeLabel);

  const promptText = useCallback((initial?: string) => new Promise<string | null>((resolve) => setPrompt({ initial, resolve })), []);

  // ---------------------------------------------------------------- mount (once per item: the shell keys the host by item id)
  useEffect(() => {
    const element = elementRef.current, host = containerRef.current;
    if (!element || !host) return;
    const engine = new CornerstoneStackEngine({
      element,
      host,
      project,
      item,
      promptText,
      onChange: () => setTick((t) => t + 1),
      onMessage: (text) => useStudio.getState().setViewerStatus(text),
    });
    engineRef.current = engine;
    void engine.mount();
    return () => {
      engine.dispose();
      engineRef.current = null;
      setViewerStatus("");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const engine = engineRef.current;
  const ready = engine?.status === "ready";

  // ---------------------------------------------------------------- tools
  const panning = useHoldToPan(ready);
  useEffect(() => {
    if (ready) engine.bindTool(tool, panning);
  }, [engine, ready, tool, panning]);
  useEffect(() => {
    if (ready) engine.applyBrush(brushSize, brushThreshold);
    // tick: brush size follows zoom; VOI drives the threshold range.
  }, [engine, ready, brushSize, brushThreshold, tick]);
  useEffect(() => {
    if (ready && activeLabel) engine.setActiveLabel(activeLabel);
  }, [engine, ready, activeLabel, project.labels]);

  // ---------------------------------------------------------------- view actions (bar + keys)
  const cfg = useRef(config);
  cfg.current = config;
  const controls = useMemo<ViewControls>(() => {
    const e = () => engineRef.current;
    return {
      toggleInvert: () => void e()?.toggleInvert(),
      flip: (axis) => void e()?.flip(axis),
      rotate: (deg) => void e()?.rotate(deg),
      reset: () => void e()?.reset(),
      setColormap: (name) => void e()?.setColormap(name),
      toggleInterpolation: () => void e()?.toggleInterpolation(),
      applyVoiPreset: (id) => void e()?.applyVoiPreset(id, cfg.current.ctPresets),
      toggleMagnifier: () => setMagnify((m) => !m),
      setWandMode: (mode) => e()?.setWandMode(mode),
      removeIslands: () => e()?.removeIslands(),
    };
  }, []);

  /** Run a view action only when the viewer is ready and the environment kept that control. */
  const gated = (on: boolean, fn: () => boolean | undefined) => () => (on && engineRef.current?.status === "ready" ? fn() !== false : false);
  useCommands(
    {
      invertImage: gated(config.invert, () => engineRef.current?.toggleInvert()),
      flipHorizontal: gated(config.flip, () => engineRef.current?.flip("h")),
      flipVertical: gated(config.flip, () => engineRef.current?.flip("v")),
      rotateView: gated(config.rotate, () => engineRef.current?.rotate(90)),
      rotateViewLeft: gated(config.rotate, () => engineRef.current?.rotate(-90)),
      fitView: gated(true, () => engineRef.current?.reset()),
      toggleMagnifier: gated(config.magnifier, () => (setMagnify((m) => !m), true)),
      // Escape cancels a Cornerstone drag or drawing; otherwise it falls through (clears the selection).
      cancelManipulation: () => engineRef.current?.cancelManipulation() ?? false,
    },
    { scope: SCOPES },
  );

  // ---------------------------------------------------------------- runtime (panel contract) + status line
  const info = engine?.info ?? null;
  const voi = ready ? engine.voi() : undefined;
  const zoom = ready ? engine.zoomPercent() : 0;
  const invert = ready ? engine.invert() : false;
  const r = engine?.readout ?? null;

  useEffect(() => {
    runtime.publish(VIEW_CONTROLS, controls);
    return () => runtime.publish(VIEW_CONTROLS, undefined);
  }, [runtime, controls]);

  const isCT = info?.modality === "CT";
  const colormap = engine?.colormap ?? "Grayscale";
  const linear = engine?.linear ?? true;
  const wandMode = engine?.wandMode ?? "flood";
  const unit = info?.unit ?? "px";
  const view = useMemo<ViewState | undefined>(
    () =>
      ready
        ? {
            features: { windowLevel: config.windowLevel, invert: config.invert, flip: config.flip, rotate: config.rotate, colormap: config.colormap, interpolation: config.interpolation, magnifier: config.magnifier },
            invert,
            colormap,
            colormaps: config.colormaps,
            linear,
            magnify,
            wandMode,
            unit,
            voiOptions: [
              { value: "", label: "Window" },
              { value: "auto", label: "Auto (1–99%)" },
              { value: "full", label: "Full range" },
              ...(isCT ? config.ctPresets.map((p) => ({ value: p.id, label: `${p.label} ${p.window}/${p.level}` })) : []),
            ],
          }
        : undefined,
    [ready, config, invert, colormap, linear, magnify, wandMode, unit, isCT],
  );
  useEffect(() => {
    runtime.publish(VIEW_STATE, view);
  }, [runtime, view]);
  useEffect(() => () => runtime.publish(VIEW_STATE, undefined), [runtime]);

  useEffect(() => {
    if (!ready || !info) return;
    setViewerStatus(
      [`${info.width}×${info.height} px`, `Zoom ${zoom}%`, config.windowLevel ? formatWL(voi) : "", r ? `(${r.x}, ${r.y}) = ${r.value}` : ""].filter(Boolean).join(" · "),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ready]);

  return (
    <div className="flex h-full w-full flex-col bg-canvas text-canvas-foreground">
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <div ref={elementRef} className="absolute inset-0" onContextMenu={(e) => e.preventDefault()} data-testid="image-canvas" />
        {ready && info && (
          <CornerText
            tl={<div>{item.name}</div>}
            tr={<div>Zoom {zoom}%</div>}
            bl={
              <>
                {config.windowLevel && <div>{formatWL(voi)}</div>}
                {r && (
                  <div>
                    ({r.x}, {r.y}) = {r.value}
                  </div>
                )}
              </>
            }
            br={
              <>
                <div>{unit === "px" ? "No pixel spacing — measurements in px" : "Calibrated (mm)"}</div>
                <div>
                  {info.width}×{info.height} {unit === "px" ? "px" : ""}
                </div>
              </>
            }
          />
        )}
        <TextPrompt request={prompt} onDone={() => setPrompt(null)} />
        <Loupe root={containerRef.current} enabled={magnify && ready} />
        {engine?.status === "loading" && <CanvasNotice loading>Loading image…</CanvasNotice>}
        {engine?.status === "error" && <CanvasNotice>{engine.error}</CanvasNotice>}
        {!engine && <CanvasNotice loading>Loading image…</CanvasNotice>}
      </div>
    </div>
  );
}
