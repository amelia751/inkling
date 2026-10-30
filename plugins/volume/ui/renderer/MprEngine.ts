import { Enums as CoreEnums, type RenderingEngine, cache, setVolumesForViewports, utilities as csUtils, volumeLoader, type Types } from "@cornerstonejs/core";
import * as tools from "@cornerstonejs/tools";
import { CornerstoneBridge, type LabelmapAccess } from "@studio/renderers/cornerstone/bridge";
import { ensureCornerstone, getRenderingEngine } from "@studio/renderers/cornerstone/init";
import { exposeForTests } from "@studio/renderers/cornerstone/interactions";
import { confidenceConnected, floodFill2D, interpolateSlices, removeIslands } from "@studio/renderers/cornerstone/regionOps";
import { encodeMask, maskId } from "@studio/renderers/cornerstone/rle";
import { applyBrushOptions, bindPrimaryTool, createToolGroup } from "@studio/renderers/cornerstone/toolGroup";
import {
  CT_PRESETS,
  flip,
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
} from "@studio/renderers/cornerstone/viewControls";
import { loadVolume } from "@studio/renderers/io/nifti";
import { directionLetters, releaseFocusAfterPointer } from "@studio/renderers/viewport-chrome/bar";
import type { RuntimeApi } from "@studio/plugin-ui-sdk/module";
import type { Annotation, Plane, Project, SeedAsset, StudioItem } from "@studio/contracts/types";
import type { Cell, Layout } from "../config";
import type { VolumeSource } from "../dataKind";
import { labelIndexForValue } from "../labelValues";
import { planeAxis, planeFromNormal, volumeConverter, type VolumeGeometry } from "./convert";
import { loadSource, scalarArray } from "./volumeCache";
import { NAMING, RES } from "@studio/contracts/naming";
import { LOCAL_AUTHOR, useHost } from "@studio/plugin-ui-sdk";

const LABELMAP = tools.Enums.SegmentationRepresentations.Labelmap;

const ORIENTATION: Record<Plane, CoreEnums.OrientationAxis> = {
  axial: CoreEnums.OrientationAxis.AXIAL,
  sagittal: CoreEnums.OrientationAxis.SAGITTAL,
  coronal: CoreEnums.OrientationAxis.CORONAL,
};

/** Per subject: the primary volume's geometry, the editable labelmap and the reference overlay. */
interface Session {
  primaryVolumeId: string;
  segmentationId: string;
  segVolumeId: string;
  refSegmentationId: string | null;
  refVolumeId: string | null;
  refLabelmap: Uint8Array | null;
  geom: VolumeGeometry;
  modality: string;
  bridge: CornerstoneBridge;
  intensity: Map<string, ArrayLike<number>>;
  voi: Map<string, VoiRange>;
}

/** Per layout / sequence: the enabled viewports and their tool groups. */
interface View {
  engine: RenderingEngine;
  ids: Partial<Record<Cell, string>>;
  mprIds: string[];
  toolGroupId: string;
  toolGroup3dId: string | null;
  syncId: string;
  volumeId: string;
  cleanup: () => void;
}

export interface Readout {
  cell: Cell;
  ijk: [number, number, number];
  value: number;
}

export interface CellInfo {
  slice: number;
  total: number;
  voi: VoiRange | undefined;
  zoom: number;
  markers: { top: string; bottom: string; left: string; right: string };
}

/** What the engine tells its React host. */
export interface EngineEvents {
  status: (status: "loading" | "ready" | "error", error?: string) => void;
  viewReady: (ready: boolean) => void;
  refReady: (ready: boolean) => void;
  /** Something visible changed (camera, VOI, readout): re-render overlays, coalesced per frame. */
  refresh: () => void;
  activeCell: (plane: Plane) => void;
  busy: (name: string | null) => void;
  viewerStatus: (text: string) => void;
  promptText: (initial?: string) => Promise<string | null>;
}

export interface EngineContext {
  project: Project;
  item: StudioItem;
  labels: string[];
  runtime: RuntimeApi;
}

export interface ViewSpec {
  layout: Layout;
  cells: Cell[];
  source: VolumeSource;
  colormap: string;
  linear: boolean;
  mip: boolean;
  showRef: boolean;
  preset3d: string;
}

export type WandMode = "flood" | "smart";

let mountSeq = 0;

/**
 * Imperative Cornerstone3D MPR engine for one subject: orthographic viewports with linked
 * crosshairs and VOI sync, an optional 3D render, brush / threshold / fill labelmap
 * editing synced to the store as RLE masks (through CornerstoneBridge), measurement tools,
 * and the dataset's reference segmentation as a read-only overlay. Owns no React state:
 * the host drives it with `open` (per subject) and `build` (per layout / sequence), both
 * returning their disposer, and re-renders on `events.refresh`.
 */
export class MprEngine {
  private session: Session | null = null;
  private view: View | null = null;
  private cellEls: Partial<Record<Cell, HTMLDivElement | null>> = {};
  /** Last camera per plane, so slices survive layout and sequence switches. */
  private cameras: Partial<Record<Plane, { layout: Layout; camera: Types.ICamera }>> = {};
  readout: Readout | null = null;
  activePlane: Plane = "axial";
  wandMode: WandMode = "flood";

  constructor(
    private ctx: () => EngineContext,
    private events: EngineEvents,
  ) {}

  setElement(cell: Cell, el: HTMLDivElement | null) {
    this.cellEls[cell] = el;
  }

  get ready(): boolean {
    return !!this.view;
  }

  get modality(): string | undefined {
    return this.session?.modality;
  }

  // ---------------------------------------------------------------- session (per subject)

  /** Load the subject's primary volume, create its labelmap and the reference overlay. Returns the disposer. */
  open(primary: VolumeSource | undefined, segAsset: SeedAsset | undefined): () => void {
    let cancelled = false;
    const seq = ++mountSeq;
    const segmentationId = `ink3d-seg-${seq}`;
    const segVolumeId = `ink3d-segvol-${seq}`;
    const refSegmentationId = `ink3d-ref-${seq}`;
    const refVolumeId = `ink3d-refvol-${seq}`;
    let created: Session | null = null;
    const { project, item, labels, runtime } = this.ctx();
    this.events.status("loading");

    (async () => {
      await ensureCornerstone();
      if (!primary) throw new Error("This subject has no image volumes.");
      const primaryVolumeId = await loadSource(primary);
      if (cancelled) return;
      const vol = cache.getVolume(primaryVolumeId)!;
      const imageData = vol.imageData!;
      const geom: VolumeGeometry = {
        dims: [...vol.dimensions] as [number, number, number],
        spacing: [...vol.spacing] as [number, number, number],
        direction: [...vol.direction],
        indexToWorld: (ijk) => [...imageData.indexToWorld(ijk as Types.Point3)] as Types.Point3,
        worldToIndex: (p) => [...imageData.worldToIndex(p)] as Types.Point3,
        frameOfReferenceUID: (vol.metadata as { FrameOfReferenceUID?: string }).FrameOfReferenceUID ?? "1.2.840.10008.1.4",
      };

      volumeLoader.createAndCacheDerivedLabelmapVolume(primaryVolumeId, { volumeId: segVolumeId });
      tools.segmentation.addSegmentations([
        {
          segmentationId,
          representation: { type: LABELMAP, data: { volumeId: segVolumeId, referencedVolumeId: primaryVolumeId } },
          config: {
            label: `${NAMING.displayName} mask`,
            segments: Object.fromEntries(labels.map((l, i) => [i + 1, { label: l, segmentIndex: i + 1 }])),
          },
        },
      ]);
      const segVm = () => cache.getVolume(segVolumeId)!.voxelManager as Types.IVoxelManager<number>;
      const intensity = new Map<string, ArrayLike<number>>();
      const s: Session = {
        primaryVolumeId,
        segmentationId,
        segVolumeId,
        refSegmentationId: null,
        refVolumeId: null,
        refLabelmap: null,
        geom,
        modality: String((vol.metadata as { Modality?: string }).Modality ?? (primary.kind === "nifti" ? "MR" : "OT")),
        intensity,
        voi: new Map(),
        bridge: null as unknown as CornerstoneBridge,
      };
      const access: LabelmapAccess = {
        segmentationId,
        dims: geom.dims,
        voxelMm3: geom.spacing[0] * geom.spacing[1] * geom.spacing[2],
        read: () => segVm().getCompleteScalarDataArray!(),
        write: (next) => {
          const vm = segVm();
          const cur = vm.getCompleteScalarDataArray!();
          let any = false;
          for (let i = 0; i < next.length; i++) {
            if (cur[i] !== next[i]) {
              vm.setAtIndex(i, next[i]);
              any = true;
            }
          }
          if (!any) return;
          tools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId, vm.getArrayOfModifiedSlices());
          vm.resetModifiedSlices();
        },
        intensity: () => {
          const id = this.view?.volumeId ?? primaryVolumeId;
          if (!intensity.has(id)) intensity.set(id, scalarArray(id));
          return intensity.get(id)!;
        },
      };
      s.bridge = new CornerstoneBridge({
        project,
        itemId: item.id,
        converter: volumeConverter(() => this.session?.geom ?? geom),
        owns: (a) => a.geometry.type === "point3d" || (a.geometry.type === "measurement" && a.geometry.space === "world"),
        labelmap: access,
        viewportIds: () => this.view?.mprIds ?? [],
        accepts: (ann) => ann.metadata?.FrameOfReferenceUID === geom.frameOfReferenceUID,
      });
      created = s;
      if (cancelled) return;
      this.session = s;
      s.bridge.start();
      runtime.publish("volume", { dims: geom.dims, spacing: geom.spacing, modality: s.modality, frameOfReferenceUID: geom.frameOfReferenceUID });
      this.events.status("ready");

      // Reference segmentation (dataset ground truth) as a separate read-only overlay.
      if (segAsset) {
        try {
          const ref = await loadVolume(segAsset.path);
          if (cancelled) return;
          const n = geom.dims[0] * geom.dims[1] * geom.dims[2];
          if (ref.data.length >= n) {
            const lm = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
              const v = ref.data[i];
              if (v) lm[i] = labelIndexForValue(project, Math.round(v)) + 1;
            }
            volumeLoader.createAndCacheDerivedLabelmapVolume(primaryVolumeId, { volumeId: refVolumeId });
            const vm = cache.getVolume(refVolumeId)!.voxelManager as Types.IVoxelManager<number>;
            for (let i = 0; i < n; i++) if (lm[i]) vm.setAtIndex(i, lm[i]);
            tools.segmentation.addSegmentations([
              {
                segmentationId: refSegmentationId,
                representation: { type: LABELMAP, data: { volumeId: refVolumeId, referencedVolumeId: primaryVolumeId } },
                config: { label: "Reference" },
              },
            ]);
            s.refSegmentationId = refSegmentationId;
            s.refVolumeId = refVolumeId;
            s.refLabelmap = lm;
            this.events.refReady(true);
          }
        } catch (e) {
          console.warn(`[${RES}] reference mask unavailable`, e);
        }
      }
    })().catch((e: Error) => {
      if (cancelled) return;
      console.error(e);
      this.events.status("error", e.message || "This volume could not be decoded.");
    });

    return () => {
      cancelled = true;
      const s = created;
      this.session = null;
      this.events.refReady(false);
      s?.bridge?.dispose();
      for (const id of [segmentationId, refSegmentationId]) {
        try {
          tools.segmentation.removeSegmentation(id);
        } catch {
          /* not created */
        }
      }
      for (const id of [segVolumeId, refVolumeId]) if (cache.getVolume(id)) cache.removeVolumeLoadObject(id);
      this.events.viewerStatus("");
    };
  }

  // ---------------------------------------------------------------- view (per layout / sequence)

  /** Enable the layout's viewports on the given source. Requires an open session. Returns the disposer. */
  build(spec: ViewSpec): () => void {
    const s = this.session;
    if (!s) return () => {};
    const { layout, cells } = spec;
    let cancelled = false;
    const seq = ++mountSeq;
    const prefix = `ink3d-${seq}`;
    const toolGroupId = `ink3d-tg-${seq}`;
    const toolGroup3dId = `ink3d-tg3d-${seq}`;
    const syncId = `ink3d-voi-${seq}`;
    let built: View | null = null;
    this.events.viewReady(false);

    (async () => {
      const volumeId = await loadSource(spec.source);
      if (cancelled) return;
      const engine = getRenderingEngine();
      const engineId = engine.id;
      const ids: Partial<Record<Cell, string>> = {};
      const inputs: Types.PublicViewportInput[] = [];
      for (const cell of cells) {
        const element = this.cellEls[cell];
        if (!element) continue;
        const id = `${prefix}-${cell}`;
        ids[cell] = id;
        inputs.push(
          cell === "3d"
            ? { viewportId: id, type: CoreEnums.ViewportType.VOLUME_3D, element, defaultOptions: { background: [0.05, 0.05, 0.07] as Types.Point3 } }
            : {
                viewportId: id,
                type: CoreEnums.ViewportType.ORTHOGRAPHIC,
                element,
                defaultOptions: { orientation: ORIENTATION[cell], background: [0, 0, 0] as Types.Point3 },
              },
        );
      }
      for (const input of inputs) engine.enableElement(input);
      const mprIds = cells.filter((c) => c !== "3d" && ids[c]).map((c) => ids[c]!);
      built = { engine, ids, mprIds, toolGroupId, toolGroup3dId: ids["3d"] ? toolGroup3dId : null, syncId, volumeId, cleanup: () => {} };
      this.view = built;

      await setVolumesForViewports(engine, [{ volumeId }], mprIds);
      if (ids["3d"]) {
        const vp3 = engine.getViewport(ids["3d"]) as Types.IVolumeViewport;
        await vp3.setVolumes([{ volumeId }]);
        try {
          vp3.setProperties({ preset: spec.preset3d });
        } catch {
          /* preset missing */
        }
        vp3.render();
      }
      if (cancelled) return;

      // Window: what the expert last chose for this sequence, else a robust percentile.
      let voi = s.voi.get(volumeId);
      if (!voi) {
        voi = s.modality === "CT" ? wlToRange(400, 40) : percentileVoi(this.intensityOf(s, volumeId));
        s.voi.set(volumeId, voi);
      }
      for (const cell of cells) {
        if (cell === "3d" || !ids[cell]) continue;
        const vp = engine.getViewport(ids[cell]!) as Types.IVolumeViewport;
        vp.setProperties({ voiRange: voi });
        if (spec.colormap !== "Grayscale") setColormap(vp, spec.colormap);
        if (!spec.linear) setInterpolation(vp, false);
        if (spec.mip) {
          vp.setBlendMode(CoreEnums.BlendModes.MAXIMUM_INTENSITY_BLEND);
          vp.setSlabThickness(10);
        }
      }

      // Tools: one group for the MPR planes, one for the 3D render.
      const tg = createToolGroup({ id: toolGroupId, mode: "3d", promptText: this.events.promptText });
      for (const id of mprIds) tg.addViewport(id, engineId);
      try {
        tg.setToolEnabled(tools.ScaleOverlayTool.toolName);
      } catch (e) {
        console.warn(`[${RES}] scale overlay unavailable`, e);
      }
      if (ids["3d"]) {
        tools.ToolGroupManager.destroyToolGroup(toolGroup3dId);
        const tg3 = tools.ToolGroupManager.createToolGroup(toolGroup3dId)!;
        tg3.addTool(tools.TrackballRotateTool.toolName);
        tg3.addTool(tools.ZoomTool.toolName);
        tg3.addTool(tools.PanTool.toolName);
        tg3.setToolActive(tools.TrackballRotateTool.toolName, { bindings: [{ mouseButton: tools.Enums.MouseBindings.Primary }] });
        tg3.setToolActive(tools.ZoomTool.toolName, { bindings: [{ mouseButton: tools.Enums.MouseBindings.Secondary }, { mouseButton: tools.Enums.MouseBindings.Wheel }] });
        tg3.setToolActive(tools.PanTool.toolName, { bindings: [{ mouseButton: tools.Enums.MouseBindings.Auxiliary }] });
        tg3.addViewport(ids["3d"], engineId);
      }
      const currentTool = useHost.getState().tool;
      // Crosshairs is bound after the cameras are restored (activating it recenters them).
      bindPrimaryTool(tg, currentTool === "crosshairs" ? "select" : currentTool, "3d");

      // Restore slices after tool binding: activating Crosshairs recenters the cameras.
      for (const cell of cells) {
        if (cell === "3d" || !ids[cell]) continue;
        const vp = engine.getViewport(ids[cell]!) as Types.IVolumeViewport;
        const saved = this.cameras[cell];
        if (saved?.layout === layout) {
          // Same layout (sequence switch): restore the exact view.
          const c = saved.camera;
          vp.setCamera({ focalPoint: c.focalPoint, position: c.position, parallelScale: c.parallelScale, viewUp: c.viewUp, viewPlaneNormal: c.viewPlaneNormal });
        } else if (saved?.camera.focalPoint) {
          // New layout: keep the slice, refit zoom/pan to the new cell.
          const fresh = vp.getCamera();
          const nrm = fresh.viewPlaneNormal!;
          const d = [0, 1, 2].reduce((acc, i) => acc + (saved.camera.focalPoint![i] - fresh.focalPoint![i]) * nrm[i], 0);
          const shift = (p: Types.Point3) => p.map((v, i) => v + nrm[i] * d) as Types.Point3;
          vp.setCamera({ focalPoint: shift(fresh.focalPoint!), position: shift(fresh.position!) });
        }
      }
      if (currentTool === "crosshairs" && mprIds.length > 1) {
        bindPrimaryTool(tg, "crosshairs", "3d");
        // Activation re-derives the crosshair centre; put it back on the saved slices.
        const sag = this.cameras.sagittal?.camera.focalPoint;
        const cor = this.cameras.coronal?.camera.focalPoint;
        const axl = this.cameras.axial?.camera.focalPoint;
        if (sag && cor && axl) {
          const center: Types.Point3 = [sag[0], cor[1], axl[2]];
          // After the first resize pass, which re-derives the centre once more.
          setTimeout(() => {
            if (cancelled) return;
            const inst = tg.getToolInstance(tools.CrosshairsTool.toolName) as { setToolCenter?: (c: Types.Point3, quiet?: boolean) => void } | undefined;
            inst?.setToolCenter?.(center);
          }, 250);
        }
      }
      // Linked W/L across the planes.
      const sync = tools.synchronizers.createVOISynchronizer(syncId, { syncInvertState: true, syncColormap: true } as never);
      for (const id of mprIds) sync.add({ renderingEngineId: engineId, viewportId: id });

      // Segmentations: the editable mask (active) and the reference overlay.
      const map: Record<string, { segmentationId: string; config?: { colorLUTOrIndex?: Types.ColorLUT } }[]> = {};
      for (const id of mprIds) {
        map[id] = [{ segmentationId: s.segmentationId, config: { colorLUTOrIndex: s.bridge.colorLUT() } }];
        if (s.refSegmentationId) map[id].push({ segmentationId: s.refSegmentationId, config: { colorLUTOrIndex: s.bridge.colorLUT() } });
      }
      tools.segmentation.addLabelmapRepresentationToViewportMap(map);
      for (const id of mprIds) {
        tools.segmentation.activeSegmentation.setActiveSegmentation(id, s.segmentationId);
        tools.segmentation.config.style.setRenderInactiveSegmentations(id, true);
      }
      applyRefStyle(s, mprIds, spec.showRef);
      s.bridge.applySegStyle();
      this.setActiveLabel(useHost.getState().activeLabel);
      s.bridge.reconcile();
      engine.render();

      // Events: overlays, readout, active viewport, VOI memory, flushing edits on mouse-up.
      const listeners: [HTMLElement, string, EventListener][] = [];
      const unfocusers: (() => void)[] = [];
      const on = (el: HTMLElement, type: string, fn: EventListener) => {
        el.addEventListener(type, fn);
        listeners.push([el, type, fn]);
      };
      const refresh = () => this.events.refresh();
      for (const cell of cells) {
        const el = this.cellEls[cell];
        const id = ids[cell];
        if (!el || !id) continue;
        for (const e of [CoreEnums.Events.CAMERA_MODIFIED, CoreEnums.Events.IMAGE_RENDERED]) on(el, e, refresh);
        if (cell === "3d") continue;
        on(el, CoreEnums.Events.VOI_MODIFIED, () => {
          const vp = engine.getViewport(id) as Types.IVolumeViewport | undefined;
          const r = vp && getVoi(vp);
          if (r) s.voi.set(volumeId, r);
          refresh();
        });
        on(el, "mouseenter", () => {
          this.activePlane = cell;
          this.events.activeCell(cell);
        });
        on(el, "mouseup", () => s.bridge.flushModified());
        unfocusers.push(releaseFocusAfterPointer(el));
        on(el, "mousemove", (evt) => {
          const vp = engine.getViewport(id) as Types.IVolumeViewport | undefined;
          if (!vp) return;
          const me = evt as MouseEvent;
          const rect = el.getBoundingClientRect();
          const world = vp.canvasToWorld([me.clientX - rect.left, me.clientY - rect.top]);
          const ijk = s.geom.worldToIndex(world).map(Math.round) as [number, number, number];
          const [nx, ny] = s.geom.dims;
          if (ijk.some((v, i) => v < 0 || v >= s.geom.dims[i])) this.readout = null;
          else this.readout = { cell, ijk, value: this.intensityOf(s, volumeId)[ijk[0] + ijk[1] * nx + ijk[2] * nx * ny] };
          refresh();
        });
        on(el, "mouseleave", () => {
          this.readout = null;
          refresh();
        });
      }
      const ro = new ResizeObserver(() => {
        engine.resize(true, true);
        refresh();
      });
      for (const cell of cells) if (this.cellEls[cell]) ro.observe(this.cellEls[cell]!);

      built.cleanup = () => {
        ro.disconnect();
        for (const [el, type, fn] of listeners) el.removeEventListener(type, fn);
        for (const off of unfocusers) off();
      };
      this.events.viewReady(true);
      refresh();
      this.exposeTestHooks(s, engine, ids);
    })().catch((e: Error) => {
      if (cancelled) return;
      console.error(e);
      this.events.status("error", e.message || "The volume could not be displayed.");
    });

    return () => {
      cancelled = true;
      exposeForTests(`__${RES}3d`, null);
      const v = built;
      if (this.view === v) this.view = null;
      if (!v) return;
      for (const cell of cells) {
        const id = v.ids[cell];
        if (!id || cell === "3d") continue;
        const vp = v.engine.getViewport(id) as Types.IVolumeViewport | undefined;
        if (vp) this.cameras[cell] = { layout, camera: vp.getCamera() };
      }
      v.cleanup();
      tools.SynchronizerManager.destroySynchronizer(v.syncId);
      for (const id of v.mprIds) {
        try {
          tools.segmentation.removeLabelmapRepresentation(id, s.segmentationId);
          if (s.refSegmentationId) tools.segmentation.removeLabelmapRepresentation(id, s.refSegmentationId);
        } catch {
          /* engine already gone */
        }
      }
      tools.ToolGroupManager.destroyToolGroup(v.toolGroupId);
      if (v.toolGroup3dId) tools.ToolGroupManager.destroyToolGroup(v.toolGroup3dId);
      for (const id of Object.values(v.ids)) if (id) v.engine.disableElement(id);
    };
  }

  /** Window hooks the e2e suite drives (`window.__<resourcePrefix>3d`). */
  private exposeTestHooks(s: Session, engine: RenderingEngine, ids: Partial<Record<Cell, string>>) {
    exposeForTests(`__${RES}3d`, {
      cells: () => Object.keys(ids),
      props: (cell: Cell) => {
        const vp = engine.getViewport(ids[cell]!) as Types.IVolumeViewport;
        const p = vp.getProperties() ?? {};
        const cam = vp.getCamera();
        const plane = planeFromNormal(cam.viewPlaneNormal) ?? (cell as Plane);
        return {
          voi: p.voiRange,
          invert: p.invert,
          colormap: (p.colormap as { name?: string } | undefined)?.name,
          focal: cam.focalPoint,
          flipH: cam.flipHorizontal,
          rotation: vp.getViewPresentation({ rotation: true }).rotation,
          zoom: vp.getZoom(),
          slice: cell === "3d" ? null : Math.round(s.geom.worldToIndex(cam.focalPoint as Types.Point3)[planeAxis(s.geom, plane)]),
          slab: vp.getSlabThickness?.(),
        };
      },
      /** Voxel (i, j, k) → page coordinates in a cell (the voxel must be on its slice). */
      ijkToClient: (cell: Cell, ijk: number[]) => {
        const vp = engine.getViewport(ids[cell]!) as Types.IVolumeViewport;
        const r = this.cellEls[cell]!.getBoundingClientRect();
        const c = vp.worldToCanvas(s.geom.indexToWorld(ijk));
        return [r.left + c[0], r.top + c[1]];
      },
      worldToClient: (cell: Cell, w: number[]) => {
        const vp = engine.getViewport(ids[cell]!) as Types.IVolumeViewport;
        const r = this.cellEls[cell]!.getBoundingClientRect();
        const c = vp.worldToCanvas(w as Types.Point3);
        return [r.left + c[0], r.top + c[1]];
      },
      geom: () => ({ dims: s.geom.dims, spacing: s.geom.spacing, modality: s.modality, for: s.geom.frameOfReferenceUID }),
      ijkToWorld: (ijk: number[]) => s.geom.indexToWorld(ijk),
      worldToIjk: (w: number[]) => s.geom.worldToIndex(w as Types.Point3),
    });
  }

  private intensityOf(s: Session, volumeId: string): ArrayLike<number> {
    if (!s.intensity.has(volumeId)) s.intensity.set(volumeId, scalarArray(volumeId));
    return s.intensity.get(volumeId)!;
  }

  // ---------------------------------------------------------------- tools and segmentation state

  private toolGroup() {
    const v = this.view;
    return v ? tools.ToolGroupManager.getToolGroup(v.toolGroupId) : undefined;
  }

  /** Bind the store tool as the primary mouse tool (Pan while Space is held). */
  bindTool(tool: string, panning: boolean, cells: Cell[]) {
    const v = this.view;
    const tg = this.toolGroup();
    if (!v || !tg) return;
    bindPrimaryTool(tg, tool === "crosshairs" && v.mprIds.length < 2 ? "select" : tool, "3d", panning ? tools.PanTool.toolName : undefined);
    for (const cell of cells) {
      const el = this.cellEls[cell];
      if (el && cell !== "3d") el.style.cursor = panning ? "grab" : tool === "wand" ? "crosshair" : "";
    }
  }

  applyBrush(size: number, threshold: boolean, sphere: boolean) {
    const tg = this.toolGroup();
    const vp = this.activeVp();
    if (tg) applyBrushOptions(tg, vp, { size, threshold }, vp ? getVoi(vp) : undefined, sphere);
  }

  setActiveLabel(label: string | null | undefined) {
    const s = this.session;
    if (!s || !label) return;
    const idx = this.ctx().labels.indexOf(label) + 1;
    if (idx > 0) tools.segmentation.segmentIndex.setActiveSegmentIndex(s.segmentationId, idx);
  }

  setReferenceVisible(visible: boolean) {
    const s = this.session;
    const v = this.view;
    if (!s || !v) return;
    applyRefStyle(s, v.mprIds, visible);
    v.engine.render();
  }

  /** ⌘/Ctrl-click toggles an annotation in the selection (Shift-click is Cornerstone's own). Returns the disposer. */
  attachSelectToggle(host: HTMLElement, cells: Cell[]): () => void {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !(e.metaKey || e.ctrlKey)) return;
      for (const cell of cells) {
        const el = this.cellEls[cell];
        if (!el || cell === "3d" || !el.contains(e.target as Node)) continue;
        const r = el.getBoundingClientRect();
        if (this.session?.bridge.toggleAt(el, [e.clientX - r.left, e.clientY - r.top])) {
          e.stopPropagation();
          e.preventDefault();
        }
      }
    };
    host.addEventListener("mousedown", onDown, true);
    return () => host.removeEventListener("mousedown", onDown, true);
  }

  /**
   * Wand clicks: 2D flood fill on the clicked slice within ±8% of the window, or (smart fill)
   * 3D confidence-connected region growing. Returns the disposer.
   */
  attachWand(cells: Cell[]): () => void {
    const v = this.view;
    if (!v) return () => {};
    const handlers: [HTMLElement, EventListener][] = [];
    for (const cell of cells) {
      const el = this.cellEls[cell];
      const id = v.ids[cell];
      if (!el || !id || cell === "3d") continue;
      const onDown = (evt: Event) => {
        const me = evt as MouseEvent;
        const s = this.session;
        const st = useHost.getState();
        const vp = v.engine.getViewport(id) as Types.IVolumeViewport | undefined;
        if (!s || !vp || me.button !== 0 || !st.activeLabel || me.metaKey || me.ctrlKey) return;
        const seg = this.ctx().labels.indexOf(st.activeLabel) + 1;
        if (seg <= 0 || st.lockedLabels.includes(st.activeLabel)) return;
        const rect = el.getBoundingClientRect();
        const world = vp.canvasToWorld([me.clientX - rect.left, me.clientY - rect.top]);
        const ijk = s.geom.worldToIndex(world).map(Math.round);
        const plane = planeFromNormal(vp.getCamera().viewPlaneNormal) ?? cell;
        const axis = planeAxis(s.geom, plane);
        const [ua, va] = [0, 1, 2].filter((a) => a !== axis);
        const dims = s.geom.dims;
        const stride = [1, dims[0], dims[0] * dims[1]];
        const data = this.intensityOf(s, v.volumeId);
        const at = (u: number, w: number) => u * stride[ua] + w * stride[va] + ijk[axis] * stride[axis];
        const voi = getVoi(vp) ?? fullRange(data);
        const tol = Math.max(1e-6, (voi.upper - voi.lower) * 0.08);
        if (ijk.some((c, a) => c < 0 || c >= dims[a])) return;
        const vm = cache.getVolume(s.segVolumeId)!.voxelManager as Types.IVoxelManager<number>;
        if (this.wandMode === "smart") {
          // 3D adaptive region growing, limited to ±40 mm around the click.
          const reach = Math.round(40 / Math.min(...s.geom.spacing));
          const region = confidenceConnected(dims, ijk, (i) => data[i], { reach, maxVoxels: 400_000 });
          if (!region) {
            this.events.viewerStatus("Smart fill stopped: the region kept growing — click inside a more uniform structure");
            return;
          }
          for (const i of region) if (vm.getAtIndex(i) === 0) vm.setAtIndex(i, seg);
        } else {
          const region = floodFill2D(dims[ua], dims[va], ijk[ua], ijk[va], (u, w) => data[at(u, w)], tol, Math.floor(dims[ua] * dims[va] * 0.4));
          if (!region) {
            this.events.viewerStatus("Fill stopped: region leaked into most of the slice — narrow the window (W/L) first");
            return;
          }
          for (const p of region) {
            const u = p % dims[ua];
            const w = (p - u) / dims[ua];
            const i = at(u, w);
            if (vm.getAtIndex(i) === 0) vm.setAtIndex(i, seg);
          }
        }
        tools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(s.segmentationId, vm.getArrayOfModifiedSlices());
        vm.resetModifiedSlices();
        s.bridge.labelmapEdited();
      };
      el.addEventListener("mousedown", onDown);
      handlers.push([el, onDown]);
    }
    return () => {
      for (const [el, fn] of handlers) el.removeEventListener("mousedown", fn);
    };
  }

  // ---------------------------------------------------------------- view actions

  vpFor(cell: Cell): Types.IVolumeViewport | undefined {
    const v = this.view;
    const id = v?.ids[cell];
    return id ? (v!.engine.getViewport(id) as Types.IVolumeViewport | undefined) : undefined;
  }

  private mprViewports(): Types.IVolumeViewport[] {
    const v = this.view;
    return (v?.mprIds ?? []).map((id) => v!.engine.getViewport(id) as Types.IVolumeViewport).filter(Boolean);
  }

  activeVp(): Types.IVolumeViewport | undefined {
    return this.vpFor(this.activePlane) ?? this.mprViewports()[0];
  }

  private forMpr(fn: (vp: Types.IVolumeViewport) => void) {
    for (const vp of this.mprViewports()) fn(vp);
    this.events.refresh();
  }

  private onActive(fn: (vp: Types.IVolumeViewport) => void) {
    const vp = this.activeVp();
    if (vp) fn(vp);
    this.events.refresh();
  }

  private setVoiAll(pick: (data: ArrayLike<number>) => VoiRange) {
    const s = this.session, v = this.view;
    if (!s || !v) return;
    const r = pick(this.intensityOf(s, v.volumeId));
    s.voi.set(v.volumeId, r);
    this.forMpr((vp) => setVoi(vp, r));
  }

  autoVoi = () => this.setVoiAll(percentileVoi);
  fullVoi = () => this.setVoiAll(fullRange);
  ctPreset(id: string) {
    const p = CT_PRESETS.find((x) => x.id === id);
    if (p) this.forMpr((vp) => setVoi(vp, wlToRange(p.window, p.level)));
  }

  isInverted(): boolean {
    const vp = this.ready ? this.activeVp() : undefined;
    return vp ? getInvert(vp) : false;
  }
  invert = () => this.forMpr((vp) => setInvert(vp, !getInvert(vp)));
  flip = (dir: "h" | "v") => this.onActive((vp) => flip(vp, dir));
  rotate = (deg: number) => this.onActive((vp) => rotate(vp, deg));
  resetAll = () => {
    this.forMpr((vp) => resetView(vp));
    this.autoVoi();
  };
  scroll = (delta: number) => this.onActive((vp) => csUtils.scroll(vp as unknown as Types.IViewport, { delta }));
  jump = (end: boolean) =>
    this.onActive((vp) => {
      const n = vp.getNumberOfSlices();
      csUtils.jumpToSlice(vp.element, { imageIndex: end ? n - 1 : 0 });
    });
  setColormap = (name: string) => this.forMpr((vp) => setColormap(vp, name));
  setInterpolation = (linear: boolean) => this.forMpr((vp) => setInterpolation(vp, linear));
  setMip = (on: boolean) =>
    this.forMpr((vp) => {
      vp.setBlendMode(on ? CoreEnums.BlendModes.MAXIMUM_INTENSITY_BLEND : CoreEnums.BlendModes.COMPOSITE);
      if (on) vp.setSlabThickness(10);
      else vp.resetSlabThickness();
      vp.render();
    });

  /** Cancel an in-progress Cornerstone drag (handle move, drawing). False when there was none. */
  cancelManipulations(): boolean {
    let canceled = false;
    for (const vp of this.mprViewports()) if (tools.cancelActiveManipulations(vp.element)) canceled = true;
    return canceled;
  }

  // ---------------------------------------------------------------- labelmap commands

  private activeSeg() {
    const label = useHost.getState().activeLabel;
    const seg = label ? this.ctx().labels.indexOf(label) + 1 : 0;
    return { label, seg };
  }

  /** Run a whole-labelmap edit on the active label off the input event, then sync it to the store. */
  private editLabelmap(name: string, fn: (data: Uint8Array, s: Session, seg: number) => number, done: (n: number, label: string) => string): boolean {
    const s = this.session;
    const { label, seg } = this.activeSeg();
    if (!s || !label || seg <= 0) return false;
    if (useHost.getState().lockedLabels.includes(label)) {
      this.events.viewerStatus(`“${label}” is locked`);
      return true;
    }
    this.events.busy(name);
    setTimeout(() => {
      try {
        const vm = cache.getVolume(s.segVolumeId)!.voxelManager as Types.IVoxelManager<number>;
        const data = Uint8Array.from(vm.getCompleteScalarDataArray!());
        const n = fn(data, s, seg);
        if (n) {
          for (let i = 0; i < data.length; i++) if (vm.getAtIndex(i) !== data[i]) vm.setAtIndex(i, data[i]);
          tools.segmentation.triggerSegmentationEvents.triggerSegmentationDataModified(s.segmentationId, vm.getArrayOfModifiedSlices());
          vm.resetModifiedSlices();
          s.bridge.labelmapEdited();
        }
        this.events.viewerStatus(done(n, label));
      } finally {
        this.events.busy(null);
      }
    }, 10);
    return true;
  }

  /** Keep only the largest connected region of the active label. */
  removeIslands(): boolean {
    return this.editLabelmap("islands", (data, s, seg) => removeIslands(data, s.geom.dims, seg), (n, label) =>
      n ? `Removed ${n.toLocaleString()} island voxels from “${label}”` : `“${label}” has no islands`,
    );
  }

  /**
   * Fill the slices between painted slices of the active label, along the active plane.
   * Shape-based interpolation in JS: @cornerstonejs/labelmap-interpolation needs the
   * @itk-wasm peer, which by default fetches its WASM from a public CDN at run time; keep
   * image-derived data on this machine instead.
   */
  interpolate(): boolean {
    const s = this.session;
    const { label, seg } = this.activeSeg();
    if (!s || !label || seg <= 0) return false;
    const plane = this.activePlane;
    const axis = planeAxis(s.geom, plane);
    return this.editLabelmap("interpolate", (data, sess, sg) => interpolateSlices(data, sess.geom.dims, sg, axis), (n, l) =>
      n ? `Interpolated “${l}” between ${plane} slices: +${n.toLocaleString()} voxels` : `Nothing to interpolate for “${l}” — paint at least two ${plane} slices with a gap`,
    );
  }

  /** Create editable masks from the reference segmentation, one undo step. */
  copyReference(): boolean {
    const s = this.session;
    if (!s?.refLabelmap) return false;
    const { item, labels } = this.ctx();
    const st = useHost.getState();
    const now = new Date().toISOString();
    const existing = st.annotations.filter((a) => a.itemId === item.id && a.geometry.type === "mask");
    const created: Annotation[] = [];
    labels.forEach((label, i) => {
      const { counts, voxels } = encodeMask(s.refLabelmap!, i + 1);
      if (!voxels) return;
      created.push({
        id: maskId(item.id, label),
        itemId: item.id,
        label,
        geometry: {
          type: "mask",
          dims: s.geom.dims,
          counts,
          voxels,
          volumeMm3: Math.round(voxels * s.geom.spacing[0] * s.geom.spacing[1] * s.geom.spacing[2] * 10) / 10,
        },
        provenance: "human-created",
        author: LOCAL_AUTHOR,
        createdAt: now,
        attributes: { source: "reference" },
      });
    });
    const replaced = existing.filter((a) => created.some((c) => c.label === a.label && !st.lockedLabels.includes(a.label)));
    st.batch({ remove: replaced.map((a) => a.id), upsert: created.filter((c) => !st.lockedLabels.includes(c.label)) });
    this.events.viewerStatus(`Copied reference into ${created.length} editable mask${created.length === 1 ? "" : "s"}`);
    return true;
  }

  // ---------------------------------------------------------------- overlays + status

  /** Corner overlays of one plane cell: slice (1-based voxel index along its axis), window, zoom, orientation. */
  cellInfo(cell: Cell): CellInfo | null {
    const vp = this.ready ? this.vpFor(cell) : undefined;
    if (!vp || cell === "3d") return null;
    const cam = vp.getCamera();
    const up = cam.viewUp ?? [0, 1, 0];
    const n = cam.viewPlaneNormal ?? [0, 0, 1];
    const right = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
    const neg = (v: number[]) => v.map((x) => -x);
    // Voxel index along the plane's axis (matches stored `slice` placements), 1-based.
    const sess = this.session;
    const plane = planeFromNormal(n) ?? (cell as Plane);
    const axis = sess ? planeAxis(sess.geom, plane) : 2;
    const k = sess && cam.focalPoint ? Math.round(sess.geom.worldToIndex(cam.focalPoint as Types.Point3)[axis]) : vp.getSliceIndex();
    return {
      slice: k + 1,
      total: sess ? sess.geom.dims[axis] : vp.getNumberOfSlices(),
      voi: getVoi(vp),
      zoom: Math.round(vp.getZoom() * 100),
      markers: { top: directionLetters(up), bottom: directionLetters(neg(up)), right: directionLetters(right), left: directionLetters(neg(right)) },
    };
  }

  /** Voxel spacing of the open subject ("1.0×1.0×1.0"), for the status line. */
  spacingText(): string | undefined {
    return this.session?.geom.spacing.map((v) => v.toFixed(1)).join("×");
  }

  activeVoi(): VoiRange | undefined {
    const vp = this.activeVp();
    return vp ? getVoi(vp) : undefined;
  }
}

function applyRefStyle(s: Session, viewportIds: string[], visible: boolean) {
  if (!s.refSegmentationId) return;
  try {
    tools.segmentation.config.style.setStyle(
      { segmentationId: s.refSegmentationId, type: LABELMAP },
      {
        renderFill: false,
        renderOutline: true,
        outlineWidth: 2,
        outlineOpacity: 0.9,
        renderFillInactive: false,
        renderOutlineInactive: true,
        outlineWidthInactive: 2,
        outlineOpacityInactive: 0.9,
      },
    );
  } catch (e) {
    console.warn(`[${RES}] reference style`, e);
  }
  for (const id of viewportIds) {
    try {
      tools.segmentation.config.visibility.setSegmentationRepresentationVisibility(id, { segmentationId: s.refSegmentationId, type: LABELMAP }, visible);
    } catch {
      /* representation not on this viewport */
    }
  }
}
