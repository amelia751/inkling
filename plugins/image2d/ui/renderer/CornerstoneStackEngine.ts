import { Enums as CoreEnums, type RenderingEngine, cache, imageLoader, utilities as csUtils, type Types } from "@cornerstonejs/core";
import * as tools from "@cornerstonejs/tools";
import { labelNames } from "@studio/contracts/environment";
import type { Project, StudioItem } from "@studio/contracts/types";
import { CornerstoneBridge, type LabelmapAccess } from "@studio/renderers/cornerstone/bridge";
import { loadDicomSeries, modalityOf, pixelSpacingOf } from "@studio/renderers/cornerstone/dicom";
import { absoluteUrl, ensureCornerstone, ensureDicom, getRenderingEngine } from "@studio/renderers/cornerstone/init";
import { exposeForTests } from "@studio/renderers/cornerstone/interactions";
import { confidenceConnected, floodFill2D, removeIslands } from "@studio/renderers/cornerstone/regionOps";
import { applyBrushOptions, bindPrimaryTool, createToolGroup } from "@studio/renderers/cornerstone/toolGroup";
import { flip, fullRange, getInvert, getVoi, percentileVoi, resetView, rotate, setColormap, setInterpolation, setInvert, setVoi, wlToRange, type VoiRange } from "@studio/renderers/cornerstone/viewControls";
import { webImageId } from "@studio/renderers/cornerstone/webImageLoader";
import { releaseFocusAfterPointer } from "@studio/renderers/viewport-chrome/bar";
import type { StackConfig, WandMode } from "../view";
import { imageConverter } from "./convert";
import { NAMING } from "@studio/contracts/naming";
import { assetUrl, useHost } from "@studio/plugin-ui-sdk";

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

export interface Readout {
  x: number;
  y: number;
  value: string;
}

export interface EngineOptions {
  /** The element Cornerstone renders into. */
  element: HTMLDivElement;
  /** Its positioned parent (catches ⌘/Ctrl-click before Cornerstone does). */
  host: HTMLDivElement;
  project: Project;
  item: StudioItem;
  /** Asks the expert for text (arrow notes). */
  promptText: (initial?: string) => Promise<string | null>;
  /** Something visible changed (camera, VOI, readout, load state); throttled to one call per frame. */
  onChange: () => void;
  /** Transient messages for the status line (fill leaks, islands removed). */
  onMessage: (text: string) => void;
}

/**
 * Imperative owner of one Cornerstone3D StackViewport: loading (web images and
 * single-frame DICOM), the tool group, the labelmap for brush / eraser / wand masks, the
 * CornerstoneBridge that mirrors store annotations as Cornerstone annotations, and every
 * view action (invert, flip, rotate, W/L presets, colormap, interpolation). The React host
 * only wires props, commands and chrome to it.
 */
export class CornerstoneStackEngine {
  status: "loading" | "ready" | "error" = "loading";
  error: string | null = null;
  readout: Readout | null = null;
  wandMode: WandMode = "flood";
  colormap = "Grayscale";
  linear = true;
  private session: Session | null = null;
  private cancelled = false;
  private tool = "select";
  private panning = false;
  private frame = 0;
  private readonly ids: { viewport: string; toolGroup: string; segmentation: string };

  constructor(private readonly o: EngineOptions) {
    const seq = ++mountSeq;
    this.ids = { viewport: `ink2d-vp-${seq}`, toolGroup: `ink2d-tg-${seq}`, segmentation: `ink2d-seg-${seq}` };
  }

  private changed = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.o.onChange();
    });
  };

  viewport(): Types.IStackViewport | undefined {
    const s = this.session;
    return s ? (s.engine.getViewport(s.viewportId) as Types.IStackViewport | undefined) : undefined;
  }

  get info(): { width: number; height: number; unit: string; modality: string } | null {
    const s = this.session;
    return s && { width: s.width, height: s.height, unit: s.unit, modality: s.modality };
  }

  voi(): VoiRange | undefined {
    const vp = this.status === "ready" ? this.viewport() : undefined;
    return vp ? getVoi(vp) : undefined;
  }

  zoomPercent(): number {
    const vp = this.status === "ready" ? this.viewport() : undefined;
    return vp ? Math.round(vp.getZoom() * 100) : 0;
  }

  invert(): boolean {
    const vp = this.status === "ready" ? this.viewport() : undefined;
    return vp ? getInvert(vp) : false;
  }

  // ---------------------------------------------------------------- lifecycle

  async mount(): Promise<void> {
    try {
      await this.load();
    } catch (e) {
      if (this.cancelled) return;
      console.error(e);
      this.error = (e as Error).message || "This image could not be decoded.";
      this.status = "error";
      this.o.onChange();
    }
  }

  private async load() {
    const { element, host, project, item } = this.o;
    const ids = this.ids;
    const asset = item.assets[0];
    if (!asset) return;
    await ensureCornerstone();
    const isDicom = /\.dcm$/i.test(asset.path);
    if (isDicom) await ensureDicom();
    const url = absoluteUrl(assetUrl(asset.path));
    const imageId = isDicom ? (await loadDicomSeries([asset.path]))[0] : webImageId(url);
    const image = await imageLoader.loadAndCacheImage(imageId);
    if (this.cancelled) return;

    const engine = getRenderingEngine();
    engine.enableElement({
      viewportId: ids.viewport,
      type: CoreEnums.ViewportType.STACK,
      element,
      defaultOptions: { background: [0, 0, 0] as Types.Point3 },
    });
    const vp = engine.getViewport(ids.viewport) as Types.IStackViewport;
    await vp.setStack([imageId]);
    if (this.cancelled) {
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

    const tg = createToolGroup({ id: ids.toolGroup, mode: "2d", promptText: this.o.promptText });
    tg.addViewport(ids.viewport, engine.id);

    // Labelmap for brush / eraser / wand masks.
    const [labelmap] = imageLoader.createAndCacheDerivedLabelmapImages([imageId]);
    tools.segmentation.addSegmentations([
      {
        segmentationId: ids.segmentation,
        representation: { type: SegmentationRepresentations.Labelmap, data: { imageIds: [labelmap.imageId] } },
        config: {
          label: `${NAMING.displayName} mask`,
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

    const onMouseUp = () => bridge.flushModified();
    const onMove = (evt: MouseEvent) => {
      const rect = element.getBoundingClientRect();
      const world = vp.canvasToWorld([evt.clientX - rect.left, evt.clientY - rect.top]);
      const [ix, iy] = csUtils.worldToImageCoords(imageId, world) as [number, number];
      const x = Math.floor(ix), y = Math.floor(iy);
      if (x < 0 || y < 0 || x >= image.columns || y >= image.rows) this.readout = null;
      else {
        const o = (y * image.columns + x) * components;
        const value = components === 1 ? String(pixels[o]) : `${pixels[o]}, ${pixels[o + 1]}, ${pixels[o + 2]}`;
        this.readout = { x, y, value };
      }
      this.changed();
    };
    const onLeave = () => {
      this.readout = null;
      this.changed();
    };
    // ⌘/Ctrl-click toggles an annotation in the selection (Shift-click is Cornerstone's own).
    const onToggle = (e: MouseEvent) => {
      if (e.button !== 0 || !(e.metaKey || e.ctrlKey)) return;
      const r = element.getBoundingClientRect();
      if (bridge.toggleAt(element, [e.clientX - r.left, e.clientY - r.top])) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    const onWand = (evt: MouseEvent) => this.wandAt(evt);
    element.addEventListener("mouseup", onMouseUp);
    const unfocus = releaseFocusAfterPointer(element);
    element.addEventListener("mousemove", onMove);
    element.addEventListener("mouseleave", onLeave);
    element.addEventListener("mousedown", onWand);
    host.addEventListener("mousedown", onToggle, true);
    const viewEvents = [CoreEnums.Events.CAMERA_MODIFIED, CoreEnums.Events.VOI_MODIFIED, CoreEnums.Events.IMAGE_RENDERED];
    for (const e of viewEvents) element.addEventListener(e, this.changed);
    const ro = new ResizeObserver(() => {
      engine.resize(true, true);
      this.changed();
    });
    ro.observe(element);

    this.session = {
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
        element.removeEventListener("mousedown", onWand);
        host.removeEventListener("mousedown", onToggle, true);
        for (const e of viewEvents) element.removeEventListener(e, this.changed);
      },
    };
    this.status = "ready";
    this.o.onChange();
    exposeForTests(`__inkling2d`, {
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
  }

  dispose(): void {
    this.cancelled = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    exposeForTests(`__inkling2d`, null);
    const s = this.session;
    this.session = null;
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
      tools.ToolGroupManager.destroyToolGroup(this.ids.toolGroup);
    }
  }

  // ---------------------------------------------------------------- tools

  /** Bind the studio tool as Cornerstone's primary tool (Pan while Space is held). */
  bindTool(tool: string, panning: boolean): void {
    this.tool = tool;
    this.panning = panning;
    const s = this.session;
    if (!s) return;
    const tg = tools.ToolGroupManager.getToolGroup(s.toolGroupId);
    if (!tg) return;
    bindPrimaryTool(tg, tool, "2d", panning ? tools.PanTool.toolName : undefined);
    this.o.element.style.cursor = panning ? "grab" : tool === "wand" ? "crosshair" : "";
  }

  /** Brush size follows zoom; VOI drives the threshold range. */
  applyBrush(size: number, threshold: boolean): void {
    const s = this.session;
    if (!s) return;
    const tg = tools.ToolGroupManager.getToolGroup(s.toolGroupId);
    const vp = this.viewport();
    if (tg) applyBrushOptions(tg, vp, { size, threshold }, vp ? getVoi(vp) : undefined, false);
  }

  setActiveLabel(label: string): void {
    const s = this.session;
    if (!s) return;
    const idx = labelNames(this.o.project.labels).indexOf(label) + 1;
    if (idx > 0) tools.segmentation.segmentIndex.setActiveSegmentIndex(s.segmentationId, idx);
  }

  /** Cancel a Cornerstone drag or drawing in progress; false when there was none. */
  cancelManipulation(): boolean {
    return !!tools.cancelActiveManipulations(this.o.element);
  }

  /** Wand: flood fill (±8% of the window) or confidence-connected smart fill from the clicked pixel. */
  private wandAt(evt: MouseEvent) {
    if (this.tool !== "wand" || this.panning || evt.metaKey || evt.ctrlKey) return;
    const s = this.session;
    const vp = this.viewport();
    const st = useHost.getState();
    if (!s || !vp || evt.button !== 0 || !st.activeLabel) return;
    const seg = labelNames(this.o.project.labels).indexOf(st.activeLabel) + 1;
    if (seg <= 0 || st.lockedLabels.includes(st.activeLabel)) return;
    const rect = this.o.element.getBoundingClientRect();
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
    const smart = this.wandMode === "smart";
    const region = smart
      ? confidenceConnected([s.width, s.height, 1], [sx, sy, 0], (i) => value(i % s.width, Math.floor(i / s.width)), {
          maxVoxels: Math.floor(s.width * s.height * 0.4),
        })
      : floodFill2D(s.width, s.height, sx, sy, value, tol);
    if (!region) {
      this.o.onMessage(
        smart
          ? "Smart fill stopped: the region grew into most of the image — click inside a more uniform structure"
          : "Fill stopped: region leaked into more than half the image — narrow the window (W/L) first",
      );
      return;
    }
    if (!tools.segmentation.state.getSegmentation(s.segmentationId)) return;
    const m = cache.getImage(s.labelmapImageId)?.voxelManager as Types.IVoxelManager<number> | undefined;
    if (!m) return;
    for (const i of region) if (m.getAtIndex(i) === 0) m.setAtIndex(i, seg);
    tools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(s.segmentationId);
    s.bridge.labelmapEdited();
  }

  /** Keep only the largest connected region of the active label's mask. */
  removeIslands(): void {
    const s = this.session;
    const label = useHost.getState().activeLabel;
    if (!s || !label) return;
    const seg = labelNames(this.o.project.labels).indexOf(label) + 1;
    const m = cache.getImage(s.labelmapImageId)?.voxelManager as Types.IVoxelManager<number> | undefined;
    if (!m || seg <= 0) return;
    const data = Array.from(m.getScalarData());
    const removed = removeIslands(data, [s.width, s.height], seg);
    if (removed) {
      for (let i = 0; i < data.length; i++) if (data[i] === 0 && m.getAtIndex(i) === seg) m.setAtIndex(i, 0);
      tools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(s.segmentationId);
      s.bridge.labelmapEdited();
    }
    this.o.onMessage(removed ? `Removed ${removed} px of islands from “${label}”` : `“${label}” has no islands`);
    this.changed();
  }

  // ---------------------------------------------------------------- view actions

  private act(fn: (vp: Types.IStackViewport, s: Session) => void): boolean {
    const s = this.session;
    const vp = this.viewport();
    if (!s || !vp || this.status !== "ready") return false;
    fn(vp, s);
    this.changed();
    return true;
  }

  private autoVoi(s: Session): VoiRange {
    return s.components === 1 ? percentileVoi(s.pixels, 0.01, 0.99, false) : { lower: 0, upper: 255 };
  }

  toggleInvert = () => this.act((vp) => setInvert(vp, !getInvert(vp)));
  flip = (axis: "h" | "v") => this.act((vp) => flip(vp, axis));
  rotate = (degrees: number) => this.act((vp) => rotate(vp, degrees));
  /** Fit: reset zoom, pan, flips and rotation, and the window to the 1–99% percentiles. */
  reset = () => this.act((vp, s) => (resetView(vp), setVoi(vp, this.autoVoi(s))));
  setColormap = (name: string) => {
    this.colormap = name;
    return this.act((vp) => setColormap(vp, name));
  };
  toggleInterpolation = () => {
    this.linear = !this.linear;
    return this.act((vp) => setInterpolation(vp, this.linear));
  };
  setWandMode = (mode: WandMode) => {
    this.wandMode = mode;
    this.changed();
  };

  /** "" (placeholder), "auto", "full" or a CT preset id. */
  applyVoiPreset = (id: string, presets: StackConfig["ctPresets"]) =>
    this.act((vp, s) => {
      if (id === "auto") setVoi(vp, this.autoVoi(s));
      else if (id === "full") setVoi(vp, s.components === 1 ? fullRange(s.pixels) : { lower: 0, upper: 255 });
      else {
        const p = presets.find((x) => x.id === id);
        if (p) setVoi(vp, wlToRange(p.window, p.level));
      }
    });
}
