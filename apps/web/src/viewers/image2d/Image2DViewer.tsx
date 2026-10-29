import { labelNames } from "@/platform/environment";
import { useCallback, useEffect, useRef, useState } from "react";
import { InvertIcon as Contrast, FlipHorizontalIcon as FlipHorizontal2, FlipVerticalIcon as FlipVertical2, FitIcon as Maximize, RotateLeftIcon as RotateCcw, RotateRightIcon as RotateCw, CleanupIcon as Sparkles, RegionIcon as SquareDashed, SearchIcon as Search, FillIcon as Wand2 } from "@/components/icons";
import { Enums as CoreEnums, type RenderingEngine, cache, imageLoader, utilities as csUtils, type Types } from "@cornerstonejs/core";
import * as tools from "@cornerstonejs/tools";
import { seedUrl } from "@/lib/api";
import { matches, useHotkeys } from "@/lib/hotkeys";
import { brushSizeOf, toolOption, useStudio } from "@/stores/studio";
import { CanvasNotice } from "@/kits/viewport-chrome/CanvasNotice";
import type { ViewerProps } from "@/viewers/ViewerAdapter";
import { CornerstoneBridge, type LabelmapAccess } from "@/kits/cornerstone/bridge";
import { absoluteUrl, ensureCornerstone, ensureDicom, getRenderingEngine } from "@/kits/cornerstone/init";
import { confidenceConnected, floodFill2D, removeIslands } from "@/kits/cornerstone/regionOps";
import { exposeForTests, Loupe, useMagnifierKey, useSpacePan } from "@/kits/cornerstone/interactions";
import { applyBrushOptions, bindPrimaryTool, createToolGroup } from "@/kits/cornerstone/toolGroup";
import { BarButton, BarLabel, BarSelect, BarSep, CornerText, TextPrompt, ViewportBar, releaseFocusAfterPointer, type PromptRequest } from "@/kits/viewport-chrome/bar";
import {
  COLORMAPS,
  CT_PRESETS,
  flip,
  formatWL,
  fullRange,
  getInvert,
  getVoi,
  percentileVoi,
  resetView,
  rotate,
  setColormap,
  setInterpolation,
  setInvert,
  setVoi,
  wlToRange,
  type VoiRange,
} from "@/kits/cornerstone/viewControls";
import { webImageId } from "@/kits/cornerstone/webImageLoader";
import { loadDicomSeries, modalityOf, pixelSpacingOf } from "@/kits/cornerstone/dicom";
import { imageConverter } from "./convert";

const { SegmentationRepresentations } = tools.Enums;
let mountSeq = 0;

interface Session {
  engine: RenderingEngine;
  viewportId: string;
  toolGroupId: string;
  segmentationId: string;
  labelmapImageId: string;
  imageId: string;
  bridge: CornerstoneBridge;
  width: number;
  height: number;
  pixels: ArrayLike<number>;
  components: number;
  modality: string;
  unit: string;
  cleanup: () => void;
}

interface Readout {
  x: number;
  y: number;
  value: string;
}

/**
 * 2D radiograph viewer on a Cornerstone3D StackViewport. Annotations live in the studio
 * store; CornerstoneBridge mirrors them as Cornerstone tool annotations (boxes as
 * RectangleROI, keypoints as Probe…) and a labelmap for brush masks.
 */
export default function Image2DViewer({ project, item }: ViewerProps) {
  const elementRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const session = useRef<Session | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [colormap, setColormapName] = useState("Grayscale");
  const [linear, setLinear] = useState(true);
  const [magnify, setMagnify] = useState(false);
  const [wandMode, setWandMode] = useState<"flood" | "smart">("flood");
  const wandModeRef = useRef(wandMode);
  wandModeRef.current = wandMode;
  const readout = useRef<Readout | null>(null);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);
  const tool = useStudio((s) => s.tool);
  const brushSize = useStudio(brushSizeOf);
  const brushThreshold = useStudio((s) => toolOption(s, "brush", "threshold", false));
  const activeLabel = useStudio((s) => s.activeLabel);
  const asset = item.assets[0];

  const promptText = useCallback(
    (initial?: string) => new Promise<string | null>((resolve) => setPrompt({ initial, resolve })),
    [],
  );

  const bump = useRef(0);
  const refresh = useCallback(() => {
    if (bump.current) return;
    bump.current = requestAnimationFrame(() => {
      bump.current = 0;
      setTick((t) => t + 1);
    });
  }, []);

  const viewport = () => {
    const s = session.current;
    return s ? (s.engine.getViewport(s.viewportId) as Types.IStackViewport | undefined) : undefined;
  };

  // ---------------------------------------------------------------- mount
  useEffect(() => {
    const element = elementRef.current;
    if (!element || !asset) return;
    let cancelled = false;
    const seq = ++mountSeq;
    const ids = {
      viewport: `ink2d-vp-${seq}`,
      toolGroup: `ink2d-tg-${seq}`,
      segmentation: `ink2d-seg-${seq}`,
    };
    setStatus("loading");
    setError(null);

    (async () => {
      await ensureCornerstone();
      const isDicom = /\.dcm$/i.test(asset.path);
      if (isDicom) await ensureDicom();
      const url = absoluteUrl(seedUrl(asset.path));
      const imageId = isDicom ? (await loadDicomSeries([asset.path]))[0] : webImageId(url);
      const image = await imageLoader.loadAndCacheImage(imageId);
      if (cancelled) return;

      const engine = getRenderingEngine();
      engine.enableElement({
        viewportId: ids.viewport,
        type: CoreEnums.ViewportType.STACK,
        element,
        defaultOptions: { background: [0, 0, 0] as Types.Point3 },
      });
      const vp = engine.getViewport(ids.viewport) as Types.IStackViewport;
      await vp.setStack([imageId]);
      if (cancelled) {
        engine.disableElement(ids.viewport);
        return;
      }
      // Image pixel → client (page) coordinates, for tests that click on known pixels.
      const v2c = (x: number, y: number) => {
        const r = element.getBoundingClientRect();
        const c = vp.worldToCanvas(csUtils.imageToWorldCoords(imageId, [x, y]) as Types.Point3);
        return [r.left + c[0], r.top + c[1]];
      };
      const pixels = image.getPixelData();
      const components = image.numberOfComponents || (image.color ? 3 : 1);
      const modality = isDicom ? (modalityOf(imageId) ?? "OT") : "OT";
      const spacing = isDicom ? pixelSpacingOf(imageId) : null;
      const unit = spacing ? "mm" : "px";
      if (components === 1 && !isDicom) setVoi(vp, fullRange(pixels));
      vp.render();

      const tg = createToolGroup({ id: ids.toolGroup, mode: "2d", promptText });
      tg.addViewport(ids.viewport, engine.id);

      // Labelmap for brush / eraser / wand masks.
      const [labelmap] = imageLoader.createAndCacheDerivedLabelmapImages([imageId]);
      tools.segmentation.addSegmentations([
        {
          segmentationId: ids.segmentation,
          representation: { type: SegmentationRepresentations.Labelmap, data: { imageIds: [labelmap.imageId] } },
          config: {
            label: "Inkling mask",
            segments: Object.fromEntries(labelNames(project.labels).map((l, i) => [i + 1, { label: l, segmentIndex: i + 1 }])),
          },
        },
      ]);
      const vm = () => (cache.getImage(labelmap.imageId) ?? labelmap).voxelManager as Types.IVoxelManager<number>;
      const access: LabelmapAccess = {
        segmentationId: ids.segmentation,
        dims: [image.columns, image.rows],
        // Pixel area in mm² when calibrated, so 2D masks report a physical area.
        voxelMm3: spacing ? spacing[0] * spacing[1] : 0,
        read: () => vm().getScalarData(),
        write: (next) => {
          const m = vm();
          const cur = m.getScalarData();
          for (let i = 0; i < next.length; i++) if (cur[i] !== next[i]) m.setAtIndex(i, next[i]);
          tools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(ids.segmentation);
        },
        intensity: () => (components === 1 ? pixels : null),
      };

      const bridge = new CornerstoneBridge({
        project,
        itemId: item.id,
        converter: imageConverter(imageId, () => engine.getViewport(ids.viewport), unit),
        owns: () => true,
        labelmap: access,
        viewportIds: () => [ids.viewport],
        accepts: (ann) => ann.metadata?.referencedImageId === imageId,
      });
      tools.segmentation.addLabelmapRepresentationToViewport(ids.viewport, [
        { segmentationId: ids.segmentation, config: { colorLUTOrIndex: bridge.colorLUT() } },
      ]);
      tools.segmentation.activeSegmentation.setActiveSegmentation(ids.viewport, ids.segmentation);
      bridge.start();

      const onMouseUp = () => {
        bridge.flushModified();
      };
      const onMove = (evt: MouseEvent) => {
        const rect = element.getBoundingClientRect();
        const world = vp.canvasToWorld([evt.clientX - rect.left, evt.clientY - rect.top]);
        const [ix, iy] = csUtils.worldToImageCoords(imageId, world) as [number, number];
        const x = Math.floor(ix), y = Math.floor(iy);
        if (x < 0 || y < 0 || x >= image.columns || y >= image.rows) readout.current = null;
        else {
          const o = (y * image.columns + x) * components;
          const value = components === 1 ? String(pixels[o]) : `${pixels[o]}, ${pixels[o + 1]}, ${pixels[o + 2]}`;
          readout.current = { x, y, value };
        }
        refresh();
      };
      const onLeave = () => {
        readout.current = null;
        refresh();
      };
      element.addEventListener("mouseup", onMouseUp);
      const unfocus = releaseFocusAfterPointer(element);
      element.addEventListener("mousemove", onMove);
      element.addEventListener("mouseleave", onLeave);
      const viewEvents = [CoreEnums.Events.CAMERA_MODIFIED, CoreEnums.Events.VOI_MODIFIED, CoreEnums.Events.IMAGE_RENDERED];
      for (const e of viewEvents) element.addEventListener(e, refresh);
      const ro = new ResizeObserver(() => {
        engine.resize(true, true);
        refresh();
      });
      ro.observe(element);

      session.current = {
        engine,
        viewportId: ids.viewport,
        toolGroupId: ids.toolGroup,
        segmentationId: ids.segmentation,
        labelmapImageId: labelmap.imageId,
        imageId,
        bridge,
        width: image.columns,
        height: image.rows,
        pixels,
        components,
        modality,
        unit,
        cleanup: () => {
          ro.disconnect();
          unfocus();
          element.removeEventListener("mouseup", onMouseUp);
          element.removeEventListener("mousemove", onMove);
          element.removeEventListener("mouseleave", onLeave);
          for (const e of viewEvents) element.removeEventListener(e, refresh);
        },
      };
      setStatus("ready");
      refresh();
      exposeForTests("__inkling2d", {
        viewport: () => engine.getViewport(ids.viewport),
        imageId,
        props: () => {
          const v = engine.getViewport(ids.viewport) as Types.IStackViewport;
          const p = v.getProperties();
          const cam = v.getCamera();
          return { voi: p.voiRange, invert: p.invert, colormap: (p.colormap as { name?: string } | undefined)?.name, interpolation: p.interpolationType, flipH: cam.flipHorizontal, flipV: cam.flipVertical, rotation: v.getViewPresentation({ rotation: true }).rotation, zoom: v.getZoom(), focal: cam.focalPoint, pan: v.getPan() };
        },
        canvasOf: (x: number, y: number) => v2c(x, y),
        toolOptions: () => JSON.parse(JSON.stringify((tools.ToolGroupManager.getToolGroup(ids.toolGroup) as unknown as { toolOptions: unknown })?.toolOptions ?? {})),
        csAnnotations: () =>
          tools.annotation.state.getAllAnnotations().map((a) => ({ uid: a.annotationUID, tool: a.metadata?.toolName, ref: a.metadata?.referencedImageId, label: a.data.label })),
      });
    })().catch((e: Error) => {
      if (cancelled) return;
      console.error(e);
      setError(e.message || "This image could not be decoded.");
      setStatus("error");
    });

    return () => {
      cancelled = true;
      exposeForTests("__inkling2d", null);
      const s = session.current;
      session.current = null;
      if (s) {
        s.cleanup();
        s.bridge.dispose();
        try {
          tools.segmentation.removeSegmentation(s.segmentationId);
        } catch {
          /* already gone */
        }
        tools.ToolGroupManager.destroyToolGroup(s.toolGroupId);
        s.engine.disableElement(s.viewportId);
        cache.removeImageLoadObject(s.labelmapImageId, { force: true });
      } else {
        tools.ToolGroupManager.destroyToolGroup(ids.toolGroup);
      }
      setViewerStatus("");
    };
    // The shell remounts the viewer per item (key=item.id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- tools
  const panning = useSpacePan(() => undefined, status === "ready");
  useMagnifierKey(() => setMagnify((m) => !m), status === "ready");

  // ⌘/Ctrl-click toggles an annotation in the selection (Shift-click is Cornerstone's own).
  useEffect(() => {
    const host = containerRef.current;
    const element = elementRef.current;
    if (status !== "ready" || !host || !element) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !(e.metaKey || e.ctrlKey)) return;
      const r = element.getBoundingClientRect();
      if (session.current?.bridge.toggleAt(element, [e.clientX - r.left, e.clientY - r.top])) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    host.addEventListener("mousedown", onDown, true);
    return () => host.removeEventListener("mousedown", onDown, true);
  }, [status]);

  useEffect(() => {
    const s = session.current;
    if (status !== "ready" || !s) return;
    const tg = tools.ToolGroupManager.getToolGroup(s.toolGroupId);
    if (!tg) return;
    bindPrimaryTool(tg, tool, "2d", panning ? tools.PanTool.toolName : undefined);
    const element = elementRef.current;
    if (element) element.style.cursor = panning ? "grab" : tool === "wand" ? "crosshair" : "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, status, panning]);

  useEffect(() => {
    const s = session.current;
    if (status !== "ready" || !s) return;
    const tg = tools.ToolGroupManager.getToolGroup(s.toolGroupId);
    const vp = viewport();
    if (tg) applyBrushOptions(tg, vp, { size: brushSize, threshold: brushThreshold }, vp ? getVoi(vp) : undefined, false);
    // tick: brush size follows zoom; VOI drives the threshold range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brushSize, brushThreshold, status, tick]);

  useEffect(() => {
    const s = session.current;
    if (status !== "ready" || !s || !activeLabel) return;
    const idx = labelNames(project.labels).indexOf(activeLabel) + 1;
    if (idx > 0) tools.segmentation.segmentIndex.setActiveSegmentIndex(s.segmentationId, idx);
  }, [activeLabel, status, project.labels]);

  // ---------------------------------------------------------------- wand (flood fill)
  useEffect(() => {
    const element = elementRef.current;
    if (status !== "ready" || !element || tool !== "wand" || panning) return;
    const onDown = (evt: MouseEvent) => {
      if (evt.metaKey || evt.ctrlKey) return;
      const s = session.current;
      const vp = viewport();
      const st = useStudio.getState();
      if (!s || !vp || evt.button !== 0 || !st.activeLabel) return;
      const seg = labelNames(project.labels).indexOf(st.activeLabel) + 1;
      if (seg <= 0 || st.lockedLabels.includes(st.activeLabel)) return;
      const rect = element.getBoundingClientRect();
      const world = vp.canvasToWorld([evt.clientX - rect.left, evt.clientY - rect.top]);
      const [ix, iy] = csUtils.worldToImageCoords(s.imageId, world) as [number, number];
      const voi = getVoi(vp) ?? { lower: 0, upper: 255 };
      const tol = Math.max(1, (voi.upper - voi.lower) * 0.08);
      const c = s.components;
      const value = (x: number, y: number) => {
        const o = (y * s.width + x) * c;
        return c === 1 ? s.pixels[o] : 0.299 * s.pixels[o] + 0.587 * s.pixels[o + 1] + 0.114 * s.pixels[o + 2];
      };
      const sx = Math.floor(ix), sy = Math.floor(iy);
      if (sx < 0 || sy < 0 || sx >= s.width || sy >= s.height) return;
      const smart = wandModeRef.current === "smart";
      const region = smart
        ? confidenceConnected([s.width, s.height, 1], [sx, sy, 0], (i) => value(i % s.width, Math.floor(i / s.width)), {
            maxVoxels: Math.floor(s.width * s.height * 0.4),
          })
        : floodFill2D(s.width, s.height, sx, sy, value, tol);
      if (!region) {
        setViewerStatus(
          smart
            ? "Smart fill stopped: the region grew into most of the image — click inside a more uniform structure"
            : "Fill stopped: region leaked into more than half the image — narrow the window (W/L) first",
        );
        return;
      }
      const lm = tools.segmentation.state.getSegmentation(s.segmentationId);
      if (!lm) return;
      const cached = cache.getImage(s.labelmapImageId);
      const m = cached?.voxelManager as Types.IVoxelManager<number> | undefined;
      if (!m) return;
      for (const i of region) if (m.getAtIndex(i) === 0) m.setAtIndex(i, seg);
      tools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(s.segmentationId);
      s.bridge.labelmapEdited();
    };
    element.addEventListener("mousedown", onDown);
    return () => element.removeEventListener("mousedown", onDown);
  }, [tool, status, project.labels, setViewerStatus, panning]);

  // ---------------------------------------------------------------- view actions
  const act = (fn: (vp: Types.IStackViewport, s: Session) => void) => {
    const s = session.current;
    const vp = viewport();
    if (s && vp) {
      fn(vp, s);
      refresh();
    }
  };
  const autoVoi = (s: Session): VoiRange =>
    s.components === 1 ? percentileVoi(s.pixels, 0.01, 0.99, false) : { lower: 0, upper: 255 };

  const removeMaskIslands = () =>
    act((_vp, s) => {
      const label = useStudio.getState().activeLabel;
      if (!label) return;
      const seg = labelNames(project.labels).indexOf(label) + 1;
      const m = cache.getImage(s.labelmapImageId)?.voxelManager as Types.IVoxelManager<number> | undefined;
      if (!m || seg <= 0) return;
      const data = Array.from(m.getScalarData());
      const removed = removeIslands(data, [s.width, s.height], seg);
      if (removed) {
        for (let i = 0; i < data.length; i++) if (data[i] === 0 && m.getAtIndex(i) === seg) m.setAtIndex(i, 0);
        tools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(s.segmentationId);
        s.bridge.labelmapEdited();
      }
      setViewerStatus(removed ? `Removed ${removed} px of islands from “${label}”` : `“${label}” has no islands`);
    });

  useHotkeys((e) => {
    if (status !== "ready") return false;
    if (matches(e, "shift+i")) return act((vp) => setInvert(vp, !getInvert(vp))), true;
    if (matches(e, "shift+h")) return act((vp) => flip(vp, "h")), true;
    if (matches(e, "shift+v")) return act((vp) => flip(vp, "v")), true;
    if (matches(e, "shift+r")) return act((vp) => rotate(vp, 90)), true;
    if (matches(e, "shift+l")) return act((vp) => rotate(vp, -90)), true;
    if ((e.key === "=" || matches(e, "0")) && !e.metaKey && !e.ctrlKey) return act((vp, s) => (resetView(vp), setVoi(vp, autoVoi(s)))), true;
    if (e.key === "Escape" && elementRef.current) {
      const canceled = tools.cancelActiveManipulations(elementRef.current);
      return !!canceled;
    }
    return false;
  });

  // ---------------------------------------------------------------- overlays / status
  const s = session.current;
  const vp = status === "ready" ? viewport() : undefined;
  const voi = vp ? getVoi(vp) : undefined;
  const zoom = vp ? Math.round(vp.getZoom() * 100) : 0;
  const r = readout.current;
  useEffect(() => {
    if (!s || !vp) return;
    setViewerStatus(
      [`${s.width}×${s.height} px`, `Zoom ${zoom}%`, formatWL(voi), r ? `(${r.x}, ${r.y}) = ${r.value}` : ""].filter(Boolean).join(" · "),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, status]);

  const isCT = s?.modality === "CT";
  const voiOptions = [
    { value: "", label: "Window" },
    { value: "auto", label: "Auto (1–99%)" },
    { value: "full", label: "Full range" },
    ...(isCT ? CT_PRESETS.map((p) => ({ value: p.id, label: `${p.label} ${p.window}/${p.level}` })) : []),
  ];
  const applyVoiPreset = (id: string) =>
    act((v, sess) => {
      if (id === "auto") setVoi(v, autoVoi(sess));
      else if (id === "full") setVoi(v, sess.components === 1 ? fullRange(sess.pixels) : { lower: 0, upper: 255 });
      else {
        const p = CT_PRESETS.find((x) => x.id === id);
        if (p) setVoi(v, wlToRange(p.window, p.level));
      }
    });
  const segTools = tool === "brush" || tool === "eraser" || tool === "wand";

  return (
    <div className="flex h-full w-full flex-col bg-canvas text-canvas-foreground">
      <ViewportBar>
        <BarSelect title="Window / level preset" value="" options={voiOptions} onChange={applyVoiPreset} />
        <BarButton icon={Contrast} title="Invert (Shift+I)" active={vp ? getInvert(vp) : false} onClick={() => act((v) => setInvert(v, !getInvert(v)))} />
        <BarSep />
        <BarButton icon={FlipHorizontal2} title="Flip horizontal (Shift+H)" onClick={() => act((v) => flip(v, "h"))} />
        <BarButton icon={FlipVertical2} title="Flip vertical (Shift+V)" onClick={() => act((v) => flip(v, "v"))} />
        <BarButton icon={RotateCcw} title="Rotate 90° left (Shift+L)" onClick={() => act((v) => rotate(v, -90))} />
        <BarButton icon={RotateCw} title="Rotate 90° right (Shift+R)" onClick={() => act((v) => rotate(v, 90))} />
        <BarButton icon={Maximize} title="Reset view (=)" onClick={() => act((v, sess) => (resetView(v), setVoi(v, autoVoi(sess))))} />
        <BarSep />
        <BarLabel>Color</BarLabel>
        <BarSelect
          title="Color map"
          value={colormap}
          options={COLORMAPS}
          onChange={(name) => {
            setColormapName(name);
            act((v) => setColormap(v, name));
          }}
        />
        <BarButton
          label={linear ? "Smooth" : "Pixels"}
          title="Interpolation: smooth (linear) or nearest-neighbour pixels"
          active={!linear}
          onClick={() => {
            setLinear(!linear);
            act((v) => setInterpolation(v, !linear));
          }}
        />
        <BarButton icon={Search} label="Magnify" title="Magnifier: 3× loupe under the cursor (M)" active={magnify} onClick={() => setMagnify((m) => !m)} />
        {tool === "wand" && (
          <>
            <BarSep />
            <BarButton label="Similar intensity" title="Fill: flood the connected region within ±8% of the window around the clicked pixel" active={wandMode === "flood"} onClick={() => setWandMode("flood")} />
            <BarButton icon={Wand2} label="Smart fill" title="Smart fill: adaptive region growing from the clicked structure's own intensity statistics (confidence-connected, no AI model)" active={wandMode === "smart"} onClick={() => setWandMode("smart")} />
          </>
        )}
        {segTools && (
          <>
            <BarSep />
            <BarButton icon={Sparkles} label="Remove islands" title="Keep only the largest connected region of the active label's mask" onClick={removeMaskIslands} />
          </>
        )}
        {s && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-canvas-foreground/50">
            <SquareDashed className="h-3 w-3" />
            {s.unit === "px" ? "No pixel spacing — measurements in px" : "Calibrated (mm)"}
          </span>
        )}
      </ViewportBar>
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <div
          ref={elementRef}
          className="absolute inset-0"
          onContextMenu={(e) => e.preventDefault()}
          data-testid="image-canvas"
        />
        {status === "ready" && s && (
          <CornerText
            tl={<div>{item.name}</div>}
            tr={<div>Zoom {zoom}%</div>}
            bl={
              <>
                <div>{formatWL(voi)}</div>
                {r && (
                  <div>
                    ({r.x}, {r.y}) = {r.value}
                  </div>
                )}
              </>
            }
            br={
              <div>
                {s.width}×{s.height} {s.unit === "px" ? "px" : ""}
              </div>
            }
          />
        )}
        <TextPrompt request={prompt} onDone={() => setPrompt(null)} />
        <Loupe root={containerRef.current} enabled={magnify && status === "ready"} />
        {status === "loading" && <CanvasNotice>Loading image…</CanvasNotice>}
        {status === "error" && <CanvasNotice>{error}</CanvasNotice>}
      </div>
    </div>
  );
}

export { Image2DViewer };
