import { useCallback, useEffect, useRef, useState } from "react";
import { VolumeIcon as Box, InvertIcon as Contrast, CopyIcon as Copy, ShowIcon as Eye, HideIcon as EyeOff, FlipHorizontalIcon as FlipHorizontal2, FlipVerticalIcon as FlipVertical2, ProjectionIcon as Layers, FitIcon as Maximize, RotateLeftIcon as RotateCcw, RotateRightIcon as RotateCw, CleanupIcon as Sparkles, InterpolateIcon as Wand2, SearchIcon as Search, FillIcon as Fill } from "@/components/icons";
import {
  Enums as CoreEnums,
  type RenderingEngine,
  cache,
  setVolumesForViewports,
  utilities as csUtils,
  volumeLoader,
  type Types,
} from "@cornerstonejs/core";
import * as tools from "@cornerstonejs/tools";
import { createNiftiImageIdsAndCacheMetadata } from "@cornerstonejs/nifti-volume-loader";
import { seedUrl } from "@/lib/api";
import { matches, useHotkeys } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { LOCAL_AUTHOR, useStudio } from "@/stores/studio";
import type { Annotation, Plane } from "@/types";
import { CanvasNotice } from "@/viewers/shared/CanvasNotice";
import type { ViewerProps } from "@/viewers/ViewerAdapter";
import { CornerstoneBridge, type LabelmapAccess } from "@/viewers/cornerstone/bridge";
import { absoluteUrl, ensureCornerstone, getRenderingEngine } from "@/viewers/cornerstone/init";
import { confidenceConnected, floodFill2D, interpolateSlices, removeIslands } from "@/viewers/cornerstone/regionOps";
import { exposeForTests, Loupe, useMagnifierKey, useSpacePan } from "@/viewers/cornerstone/interactions";
import { encodeMask, maskId } from "@/viewers/cornerstone/rle";
import { applyBrushOptions, bindPrimaryTool, createToolGroup } from "@/viewers/cornerstone/toolGroup";
import {
  BarButton,
  BarLabel,
  BarSelect,
  BarSep,
  CornerText,
  OrientationMarkers,
  TextPrompt,
  ViewportBar,
  directionLetters,
  releaseFocusAfterPointer,
  type PromptRequest,
} from "@/viewers/cornerstone/ui";
import {
  COLORMAPS,
  CT_PRESETS,
  wlToRange,
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
  type VoiRange,
} from "@/viewers/cornerstone/viewControls";
import { loadVolume } from "./nifti";
import { isDicomPath, loadDicomSeries } from "@/viewers/cornerstone/dicom";
import { labelIndexForValue } from "./niftiExport";
import { PLANES, planeAxis, planeFromNormal, volumeConverter, type VolumeGeometry } from "./convert";

const { SegmentationRepresentations } = tools.Enums;
const LABELMAP = SegmentationRepresentations.Labelmap;

type Layout = "mpr" | "main" | "single" | "mpr3d";
type Cell = Plane | "3d";

const LAYOUTS: { value: Layout; label: string }[] = [
  { value: "mpr", label: "1×3 MPR" },
  { value: "main", label: "1 + 2" },
  { value: "single", label: "Single plane" },
  { value: "mpr3d", label: "MPR + 3D" },
];

const ORIENTATION: Record<Plane, CoreEnums.OrientationAxis> = {
  axial: CoreEnums.OrientationAxis.AXIAL,
  sagittal: CoreEnums.OrientationAxis.SAGITTAL,
  coronal: CoreEnums.OrientationAxis.CORONAL,
};

function cellsFor(layout: Layout, single: Plane): Cell[] {
  if (layout === "single") return [single];
  if (layout === "mpr3d") return ["axial", "sagittal", "coronal", "3d"];
  return ["axial", "sagittal", "coronal"];
}

// ------------------------------------------------------------------ volume cache

const volumePromises = new Map<string, Promise<string>>();

/** Load a NIfTI file into Cornerstone's cache once per session (shared across mounts). */
function loadNiftiVolume(path: string): Promise<string> {
  let p = volumePromises.get(path);
  if (!p) {
    p = (async () => {
      const volumeId = `cornerstoneStreamingImageVolume:ink:${path}`;
      let vol = cache.getVolume(volumeId) as (Types.IImageVolume & { loadStatus?: { loaded?: boolean } }) | undefined;
      if (!vol) {
        const imageIds = await createNiftiImageIdsAndCacheMetadata({ url: absoluteUrl(seedUrl(path)) });
        if (!imageIds?.length) throw new Error(`Could not read ${path}`);
        vol = (await volumeLoader.createAndCacheVolume(volumeId, { imageIds })) as unknown as typeof vol;
      }
      if (!vol!.loadStatus?.loaded) {
        await new Promise<void>((resolve) => {
          vol!.load(() => resolve());
          if (vol!.loadStatus?.loaded) resolve();
        });
      }
      return volumeId;
    })();
    p.catch(() => volumePromises.delete(path));
    volumePromises.set(path, p);
  }
  return p;
}

/** Load a DICOM series (wadouri) as one volume, in Cornerstone's slice order. */
function loadDicomVolume(paths: string[]): Promise<string> {
  const key = `dicom:${paths[0]}:${paths.length}`;
  let p = volumePromises.get(key);
  if (!p) {
    p = (async () => {
      const volumeId = `cornerstoneStreamingImageVolume:ink:${key}`;
      let vol = cache.getVolume(volumeId) as (Types.IImageVolume & { loadStatus?: { loaded?: boolean } }) | undefined;
      if (!vol) {
        const imageIds = await loadDicomSeries(paths);
        vol = (await volumeLoader.createAndCacheVolume(volumeId, { imageIds })) as unknown as typeof vol;
      }
      if (!vol!.loadStatus?.loaded) {
        await new Promise<void>((resolve) => {
          vol!.load(() => resolve());
          if (vol!.loadStatus?.loaded) resolve();
        });
      }
      return volumeId;
    })();
    p.catch(() => volumePromises.delete(key));
    volumePromises.set(key, p);
  }
  return p;
}

/** One displayable volume of a subject: a NIfTI sequence, or a whole DICOM series. */
export interface VolumeSource {
  key: string;
  label: string;
  kind: "nifti" | "dicom";
  paths: string[];
}

export function volumeSources(assets: { path: string; sequence?: string }[]): VolumeSource[] {
  const groups = new Map<string, VolumeSource>();
  for (const a of assets) {
    if (a.sequence === "seg") continue;
    const dicom = isDicomPath(a.path);
    const key = a.sequence ?? (dicom ? "series" : a.path);
    const g = groups.get(key) ?? { key, label: a.sequence ?? (dicom ? "Series" : a.path.split("/").pop()!), kind: dicom ? "dicom" : "nifti", paths: [] };
    g.paths.push(a.path);
    groups.set(key, g);
  }
  return [...groups.values()];
}

function loadSource(src: VolumeSource): Promise<string> {
  return src.kind === "dicom" ? loadDicomVolume(src.paths) : loadNiftiVolume(src.paths[0]);
}

function scalarArray(volumeId: string): ArrayLike<number> {
  const vol = cache.getVolume(volumeId);
  return vol?.voxelManager?.getCompleteScalarDataArray?.() ?? [];
}

// ------------------------------------------------------------------ types

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

interface Readout {
  cell: Cell;
  ijk: [number, number, number];
  value: number;
}

let mountSeq = 0;

/**
 * 3D volume viewer (MRI subjects) on Cornerstone3D: orthographic MPR viewports with
 * linked crosshairs and VOI sync, optional 3D rendering, brush/threshold/fill labelmap
 * editing synced to the store as RLE masks, measurement tools, and the dataset's
 * reference segmentation as a read-only overlay.
 */
export default function Volume3DViewer({ project, item }: ViewerProps) {
  const labels = project.labels ?? [];
  const sequences = volumeSources(item.assets);
  const segAsset = item.assets.find((a) => a.sequence === "seg");
  const [sequence, setSequence] = useState(() => (sequences.find((a) => a.key === "flair") ?? sequences[0])?.key);
  const [layout, setLayout] = useState<Layout>("mpr");
  const [single, setSingle] = useState<Plane>("axial");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [viewReady, setViewReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRef, setShowRef] = useState(true);
  const [refReady, setRefReady] = useState(false);
  const [mip, setMip] = useState(false);
  const [sphere, setSphere] = useState(false);
  const [magnify, setMagnify] = useState(false);
  const [wandMode, setWandMode] = useState<"flood" | "smart">("flood");
  const wandModeRef = useRef(wandMode);
  wandModeRef.current = wandMode;
  const gridRef = useRef<HTMLDivElement>(null);
  const [colormap, setColormapName] = useState("Grayscale");
  const [linear, setLinear] = useState(true);
  const [activeCell, setActiveCell] = useState<Plane>("axial");
  const [busy, setBusy] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [tick, setTick] = useState(0);
  const session = useRef<Session | null>(null);
  const view = useRef<View | null>(null);
  const cellEls = useRef<Partial<Record<Cell, HTMLDivElement | null>>>({});
  const cameras = useRef<Partial<Record<Plane, { layout: Layout; camera: Types.ICamera }>>>({});
  const readout = useRef<Readout | null>(null);
  const activeRef = useRef<Plane>("axial");
  const tool = useStudio((s) => s.tool);
  const toolOptions = useStudio((s) => s.toolOptions);
  const activeLabel = useStudio((s) => s.activeLabel);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);
  const cells = cellsFor(layout, single);

  const promptText = useCallback((initial?: string) => new Promise<string | null>((resolve) => setPrompt({ initial, resolve })), []);
  const raf = useRef(0);
  const refresh = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      setTick((t) => t + 1);
    });
  }, []);

  const vpFor = (cell: Cell) => {
    const v = view.current;
    const id = v?.ids[cell];
    return id ? (v!.engine.getViewport(id) as Types.IVolumeViewport | undefined) : undefined;
  };
  const mprViewports = () => (view.current?.mprIds ?? []).map((id) => view.current!.engine.getViewport(id) as Types.IVolumeViewport).filter(Boolean);
  const activeVp = () => vpFor(activeRef.current) ?? mprViewports()[0];

  // ---------------------------------------------------------------- session (per subject)
  useEffect(() => {
    let cancelled = false;
    const seq = ++mountSeq;
    const segmentationId = `ink3d-seg-${seq}`;
    const segVolumeId = `ink3d-segvol-${seq}`;
    const refSegmentationId = `ink3d-ref-${seq}`;
    const refVolumeId = `ink3d-refvol-${seq}`;
    let created: Session | null = null;
    setStatus("loading");

    (async () => {
      await ensureCornerstone();
      const primary = sequences.find((a) => a.key === sequence) ?? sequences[0];
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
            label: "Inkling mask",
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
          const id = view.current?.volumeId ?? primaryVolumeId;
          if (!intensity.has(id)) intensity.set(id, scalarArray(id));
          return intensity.get(id)!;
        },
      };
      s.bridge = new CornerstoneBridge({
        project,
        itemId: item.id,
        converter: volumeConverter(() => session.current?.geom ?? geom),
        owns: (a) => a.geometry.type === "point" || (a.geometry.type === "measurement" && a.geometry.space === "world"),
        labelmap: access,
        viewportIds: () => view.current?.mprIds ?? [],
        accepts: (ann) => ann.metadata?.FrameOfReferenceUID === geom.frameOfReferenceUID,
      });
      created = s;
      if (cancelled) return;
      session.current = s;
      s.bridge.start();
      setStatus("ready");

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
            setRefReady(true);
          }
        } catch (e) {
          console.warn("[inkling] reference mask unavailable", e);
        }
      }
    })().catch((e: Error) => {
      if (cancelled) return;
      console.error(e);
      setError(e.message || "This volume could not be decoded.");
      setStatus("error");
    });

    return () => {
      cancelled = true;
      const s = created;
      session.current = null;
      setRefReady(false);
      s?.bridge?.dispose();
      for (const id of [segmentationId, refSegmentationId]) {
        try {
          tools.segmentation.removeSegmentation(id);
        } catch {
          /* not created */
        }
      }
      for (const id of [segVolumeId, refVolumeId]) if (cache.getVolume(id)) cache.removeVolumeLoadObject(id);
      setViewerStatus("");
    };
    // Remounted per item by the shell; the primary sequence only seeds the label grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- view (per layout / sequence)
  useEffect(() => {
    const s = session.current;
    if (status !== "ready" || !s) return;
    let cancelled = false;
    const seq = ++mountSeq;
    const prefix = `ink3d-${seq}`;
    const toolGroupId = `ink3d-tg-${seq}`;
    const toolGroup3dId = `ink3d-tg3d-${seq}`;
    const syncId = `ink3d-voi-${seq}`;
    let built: View | null = null;
    const builtLayout = layout;
    setViewReady(false);

    (async () => {
      const source = sequences.find((a) => a.key === sequence) ?? sequences[0];
      const volumeId = await loadSource(source);
      if (cancelled) return;
      const engine = getRenderingEngine();
      const engineId = engine.id;
      const ids: Partial<Record<Cell, string>> = {};
      const inputs: Types.PublicViewportInput[] = [];
      for (const cell of cells) {
        const element = cellEls.current[cell];
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
      view.current = built;

      await setVolumesForViewports(engine, [{ volumeId }], mprIds);
      if (ids["3d"]) {
        const vp3 = engine.getViewport(ids["3d"]) as Types.IVolumeViewport;
        await vp3.setVolumes([{ volumeId }]);
        try {
          vp3.setProperties({ preset: "MR-Default" });
        } catch {
          /* preset missing */
        }
        vp3.render();
      }
      if (cancelled) return;

      // Window: what the expert last chose for this sequence, else a robust percentile.
      let voi = s.voi.get(volumeId);
      if (!voi) {
        if (!s.intensity.has(volumeId)) s.intensity.set(volumeId, scalarArray(volumeId));
        voi = s.modality === "CT" ? wlToRange(400, 40) : percentileVoi(s.intensity.get(volumeId)!);
        s.voi.set(volumeId, voi);
      }
      for (const cell of cells) {
        if (cell === "3d" || !ids[cell]) continue;
        const vp = engine.getViewport(ids[cell]!) as Types.IVolumeViewport;
        vp.setProperties({ voiRange: voi });
        if (colormap !== "Grayscale") setColormap(vp, colormap);
        if (!linear) setInterpolation(vp, false);
        if (mip) {
          vp.setBlendMode(CoreEnums.BlendModes.MAXIMUM_INTENSITY_BLEND);
          vp.setSlabThickness(10);
        }
      }

      // Tools: one group for the MPR planes, one for the 3D render.
      const tg = createToolGroup({ id: toolGroupId, mode: "3d", promptText });
      for (const id of mprIds) tg.addViewport(id, engineId);
      try {
        tg.setToolEnabled(tools.ScaleOverlayTool.toolName);
      } catch (e) {
        console.warn("[inkling] scale overlay unavailable", e);
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
      const currentTool = useStudio.getState().tool;
      // Crosshairs is bound after the cameras are restored (activating it recenters them).
      bindPrimaryTool(tg, currentTool === "crosshairs" ? "select" : currentTool, "3d");

      // Restore slices after tool binding: activating Crosshairs recenters the cameras.
      for (const cell of cells) {
        if (cell === "3d" || !ids[cell]) continue;
        const vp = engine.getViewport(ids[cell]!) as Types.IVolumeViewport;
        const saved = cameras.current[cell];
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
        const sag = cameras.current.sagittal?.camera.focalPoint;
        const cor = cameras.current.coronal?.camera.focalPoint;
        const axl = cameras.current.axial?.camera.focalPoint;
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
      applyRefStyle(s, mprIds, showRef);
      s.bridge.applySegStyle();
      const idx = labels.indexOf(useStudio.getState().activeLabel ?? "") + 1;
      if (idx > 0) tools.segmentation.segmentIndex.setActiveSegmentIndex(s.segmentationId, idx);
      s.bridge.reconcile();
      engine.render();

      // Events: overlays, readout, active viewport, VOI memory, flushing edits on mouse-up.
      const listeners: [HTMLElement, string, EventListener][] = [];
      const unfocusers: (() => void)[] = [];
      const on = (el: HTMLElement, type: string, fn: EventListener) => {
        el.addEventListener(type, fn);
        listeners.push([el, type, fn]);
      };
      for (const cell of cells) {
        const el = cellEls.current[cell];
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
          activeRef.current = cell;
          setActiveCell(cell);
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
          const [nx, ny, nz] = s.geom.dims;
          if (ijk.some((v, i) => v < 0 || v >= s.geom.dims[i])) readout.current = null;
          else {
            if (!s.intensity.has(volumeId)) s.intensity.set(volumeId, scalarArray(volumeId));
            const data = s.intensity.get(volumeId)!;
            readout.current = { cell, ijk, value: data[ijk[0] + ijk[1] * nx + ijk[2] * nx * ny] };
            void nz;
          }
          refresh();
        });
        on(el, "mouseleave", () => {
          readout.current = null;
          refresh();
        });
      }
      const ro = new ResizeObserver(() => {
        engine.resize(true, true);
        refresh();
      });
      for (const cell of cells) if (cellEls.current[cell]) ro.observe(cellEls.current[cell]!);

      built.cleanup = () => {
        ro.disconnect();
        for (const [el, type, fn] of listeners) el.removeEventListener(type, fn);
        for (const off of unfocusers) off();
      };
      setViewReady(true);
      refresh();
      exposeForTests("__inkling3d", {
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
          const r = cellEls.current[cell]!.getBoundingClientRect();
          const c = vp.worldToCanvas(s.geom.indexToWorld(ijk));
          return [r.left + c[0], r.top + c[1]];
        },
        worldToClient: (cell: Cell, w: number[]) => {
          const vp = engine.getViewport(ids[cell]!) as Types.IVolumeViewport;
          const r = cellEls.current[cell]!.getBoundingClientRect();
          const c = vp.worldToCanvas(w as Types.Point3);
          return [r.left + c[0], r.top + c[1]];
        },
        geom: () => ({ dims: s.geom.dims, spacing: s.geom.spacing, modality: s.modality, for: s.geom.frameOfReferenceUID }),
        ijkToWorld: (ijk: number[]) => s.geom.indexToWorld(ijk),
        worldToIjk: (w: number[]) => s.geom.worldToIndex(w as Types.Point3),
      });
    })().catch((e: Error) => {
      if (cancelled) return;
      console.error(e);
      setError(e.message || "The volume could not be displayed.");
      setStatus("error");
    });

    return () => {
      cancelled = true;
      exposeForTests("__inkling3d", null);
      const v = built;
      if (view.current === v) view.current = null;
      if (!v) return;
      for (const cell of cells) {
        const id = v.ids[cell];
        if (!id || cell === "3d") continue;
        const vp = v.engine.getViewport(id) as Types.IVolumeViewport | undefined;
        if (vp) cameras.current[cell] = { layout: builtLayout, camera: vp.getCamera() };
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
    // Colormap / interpolation / MIP are applied live below; they only seed a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, layout, single, sequence]);

  // ---------------------------------------------------------------- tool binding
  const panning = useSpacePan(() => undefined, viewReady);
  useMagnifierKey(() => setMagnify((m) => !m), viewReady);
  useEffect(() => {
    const v = view.current;
    if (!viewReady || !v) return;
    const tg = tools.ToolGroupManager.getToolGroup(v.toolGroupId);
    if (!tg) return;
    bindPrimaryTool(tg, tool === "crosshairs" && v.mprIds.length < 2 ? "select" : tool, "3d", panning ? tools.PanTool.toolName : undefined);
    for (const cell of cells) {
      const el = cellEls.current[cell];
      if (el && cell !== "3d") el.style.cursor = panning ? "grab" : tool === "wand" ? "crosshair" : "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, viewReady, panning]);

  // ⌘/Ctrl-click toggles an annotation in the selection (Shift-click is Cornerstone's own).
  useEffect(() => {
    const host = gridRef.current;
    if (!viewReady || !host) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || !(e.metaKey || e.ctrlKey)) return;
      for (const cell of cells) {
        const el = cellEls.current[cell];
        if (!el || cell === "3d" || !el.contains(e.target as Node)) continue;
        const r = el.getBoundingClientRect();
        if (session.current?.bridge.toggleAt(el, [e.clientX - r.left, e.clientY - r.top])) {
          e.stopPropagation();
          e.preventDefault();
        }
      }
    };
    host.addEventListener("mousedown", onDown, true);
    return () => host.removeEventListener("mousedown", onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewReady, layout, single]);

  useEffect(() => {
    const v = view.current;
    if (!viewReady || !v) return;
    const tg = tools.ToolGroupManager.getToolGroup(v.toolGroupId);
    const vp = activeVp();
    if (tg) applyBrushOptions(tg, vp, toolOptions, vp ? getVoi(vp) : undefined, sphere);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolOptions, viewReady, sphere, tick, activeCell]);

  useEffect(() => {
    const s = session.current;
    if (!viewReady || !s || !activeLabel) return;
    const idx = labels.indexOf(activeLabel) + 1;
    if (idx > 0) tools.segmentation.segmentIndex.setActiveSegmentIndex(s.segmentationId, idx);
  }, [activeLabel, viewReady, labels]);

  useEffect(() => {
    const s = session.current;
    const v = view.current;
    if (!viewReady || !s || !v) return;
    applyRefStyle(s, v.mprIds, showRef);
    v.engine.render();
  }, [showRef, viewReady, refReady]);

  // ---------------------------------------------------------------- wand (2D flood fill on the clicked slice)
  useEffect(() => {
    const v = view.current;
    if (!viewReady || !v || tool !== "wand" || panning) return;
    const handlers: [HTMLElement, EventListener][] = [];
    for (const cell of cells) {
      const el = cellEls.current[cell];
      const id = v.ids[cell];
      if (!el || !id || cell === "3d") continue;
      const onDown = (evt: Event) => {
        const me = evt as MouseEvent;
        const s = session.current;
        const st = useStudio.getState();
        const vp = v.engine.getViewport(id) as Types.IVolumeViewport | undefined;
        if (!s || !vp || me.button !== 0 || !st.activeLabel || me.metaKey || me.ctrlKey) return;
        const seg = labels.indexOf(st.activeLabel) + 1;
        if (seg <= 0 || st.lockedLabels.includes(st.activeLabel)) return;
        const rect = el.getBoundingClientRect();
        const world = vp.canvasToWorld([me.clientX - rect.left, me.clientY - rect.top]);
        const ijk = s.geom.worldToIndex(world).map(Math.round);
        const plane = planeFromNormal(vp.getCamera().viewPlaneNormal) ?? cell;
        const axis = planeAxis(s.geom, plane);
        const [ua, va] = [0, 1, 2].filter((a) => a !== axis);
        const dims = s.geom.dims;
        const stride = [1, dims[0], dims[0] * dims[1]];
        const data = s.intensity.get(v.volumeId) ?? scalarArray(v.volumeId);
        s.intensity.set(v.volumeId, data);
        const at = (u: number, w: number) => u * stride[ua] + w * stride[va] + ijk[axis] * stride[axis];
        const voi = getVoi(vp) ?? fullRange(data);
        const tol = Math.max(1e-6, (voi.upper - voi.lower) * 0.08);
        if (ijk.some((c, a) => c < 0 || c >= dims[a])) return;
        const vm = cache.getVolume(s.segVolumeId)!.voxelManager as Types.IVoxelManager<number>;
        if (wandModeRef.current === "smart") {
          // 3D adaptive region growing, limited to ±40 mm around the click.
          const reach = Math.round(40 / Math.min(...s.geom.spacing));
          const region = confidenceConnected(dims, ijk, (i) => data[i], { reach, maxVoxels: 400_000 });
          if (!region) {
            setViewerStatus("Smart fill stopped: the region kept growing — click inside a more uniform structure");
            return;
          }
          for (const i of region) if (vm.getAtIndex(i) === 0) vm.setAtIndex(i, seg);
        } else {
          const region = floodFill2D(dims[ua], dims[va], ijk[ua], ijk[va], (u, w) => data[at(u, w)], tol, Math.floor(dims[ua] * dims[va] * 0.4));
          if (!region) {
            setViewerStatus("Fill stopped: region leaked into most of the slice — narrow the window (W/L) first");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, viewReady, labels, panning]);

  // ---------------------------------------------------------------- actions
  const forMpr = (fn: (vp: Types.IVolumeViewport) => void) => {
    for (const vp of mprViewports()) fn(vp);
    refresh();
  };
  const onActive = (fn: (vp: Types.IVolumeViewport) => void) => {
    const vp = activeVp();
    if (vp) fn(vp);
    refresh();
  };
  const autoVoi = () => {
    const s = session.current, v = view.current;
    if (!s || !v) return;
    if (!s.intensity.has(v.volumeId)) s.intensity.set(v.volumeId, scalarArray(v.volumeId));
    const r = percentileVoi(s.intensity.get(v.volumeId)!);
    s.voi.set(v.volumeId, r);
    forMpr((vp) => setVoi(vp, r));
  };
  const fullVoi = () => {
    const s = session.current, v = view.current;
    if (!s || !v) return;
    if (!s.intensity.has(v.volumeId)) s.intensity.set(v.volumeId, scalarArray(v.volumeId));
    const r = fullRange(s.intensity.get(v.volumeId)!);
    s.voi.set(v.volumeId, r);
    forMpr((vp) => setVoi(vp, r));
  };
  const resetAll = () => {
    forMpr((vp) => resetView(vp));
    autoVoi();
  };
  const scroll = (delta: number) => onActive((vp) => csUtils.scroll(vp as unknown as Types.IViewport, { delta }));
  const jump = (end: boolean) =>
    onActive((vp) => {
      const n = vp.getNumberOfSlices();
      csUtils.jumpToSlice(vp.element, { imageIndex: end ? n - 1 : 0 });
    });
  const toggleMip = () => {
    const next = !mip;
    setMip(next);
    forMpr((vp) => {
      vp.setBlendMode(next ? CoreEnums.BlendModes.MAXIMUM_INTENSITY_BLEND : CoreEnums.BlendModes.COMPOSITE);
      if (next) vp.setSlabThickness(10);
      else vp.resetSlabThickness();
      vp.render();
    });
  };

  const activeSeg = () => {
    const label = useStudio.getState().activeLabel;
    const seg = label ? labels.indexOf(label) + 1 : 0;
    return { label, seg };
  };

  const editLabelmap = (name: string, fn: (data: Uint8Array, s: Session, seg: number) => number, done: (n: number, label: string) => string) => {
    const s = session.current;
    const { label, seg } = activeSeg();
    if (!s || !label || seg <= 0) return;
    if (useStudio.getState().lockedLabels.includes(label)) {
      setViewerStatus(`“${label}” is locked`);
      return;
    }
    setBusy(name);
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
        setViewerStatus(done(n, label));
      } finally {
        setBusy(null);
      }
    }, 10);
  };

  const removeMaskIslands = () =>
    editLabelmap("islands", (data, s, seg) => removeIslands(data, s.geom.dims, seg), (n, label) =>
      n ? `Removed ${n.toLocaleString()} island voxels from “${label}”` : `“${label}” has no islands`,
    );

  // Shape-based interpolation in JS. @cornerstonejs/labelmap-interpolation needs the
  // @itk-wasm peer, which by default fetches its WASM from a public CDN at run time;
  // keep image-derived data on this machine instead.
  const interpolate = () => {
    const s = session.current;
    const { label, seg } = activeSeg();
    if (!s || !label || seg <= 0) return;
    const plane = activeRef.current;
    const axis = planeAxis(s.geom, plane);
    editLabelmap("interpolate", (data, sess, sg) => interpolateSlices(data, sess.geom.dims, sg, axis), (n, l) =>
      n ? `Interpolated “${l}” between ${plane} slices: +${n.toLocaleString()} voxels` : `Nothing to interpolate for “${l}” — paint at least two ${plane} slices with a gap`,
    );
  };

  const copyReference = () => {
    const s = session.current;
    if (!s?.refLabelmap) return;
    const st = useStudio.getState();
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
    setViewerStatus(`Copied reference into ${created.length} editable mask${created.length === 1 ? "" : "s"}`);
  };

  // ---------------------------------------------------------------- keyboard
  useHotkeys((e) => {
    if (!viewReady) return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === "ArrowUp" && !e.shiftKey) return scroll(-1), true;
    if (e.key === "ArrowDown" && !e.shiftKey) return scroll(1), true;
    if (e.key === "Home") return jump(false), true;
    if (e.key === "End") return jump(true), true;
    if (matches(e, "shift+i")) return forMpr((vp) => setInvert(vp, !getInvert(vp))), true;
    if (matches(e, "shift+h")) return onActive((vp) => flip(vp, "h")), true;
    if (matches(e, "shift+v")) return onActive((vp) => flip(vp, "v")), true;
    if (matches(e, "shift+r")) return onActive((vp) => rotate(vp, 90)), true;
    if (matches(e, "shift+l")) return onActive((vp) => rotate(vp, -90)), true;
    if (e.key === "=") return resetAll(), true;
    if (e.key === "Escape") {
      let canceled = false;
      for (const vp of mprViewports()) if (tools.cancelActiveManipulations(vp.element)) canceled = true;
      return canceled;
    }
    return false;
  });

  // ---------------------------------------------------------------- overlays + status
  const s = session.current;
  const info = (cell: Cell) => {
    const vp = viewReady ? vpFor(cell) : undefined;
    if (!vp || cell === "3d") return null;
    const cam = vp.getCamera();
    const up = cam.viewUp ?? [0, 1, 0];
    const n = cam.viewPlaneNormal ?? [0, 0, 1];
    const right = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
    const neg = (v: number[]) => v.map((x) => -x);
    // Voxel index along the plane's axis (matches stored `slice` placements), 1-based.
    const sess = session.current;
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
  };
  useEffect(() => {
    if (!viewReady || !s) return;
    const parts = (["axial", "sagittal", "coronal"] as Plane[])
      .map((p) => {
        const i = info(p);
        return i ? `${p[0].toUpperCase()}${p.slice(1)} ${i.slice}/${i.total}` : null;
      })
      .filter(Boolean);
    const sp = s.geom.spacing.map((v) => v.toFixed(1)).join("×");
    const r = readout.current;
    const voi = activeVp() ? getVoi(activeVp()!) : undefined;
    setViewerStatus(
      [...parts, `${sp} mm`, formatWL(voi), r ? `[${r.ijk.join(", ")}] = ${Math.round(r.value * 100) / 100}` : ""].filter(Boolean).join(" · "),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, viewReady]);

  if (status === "error") {
    return (
      <div className="relative h-full w-full bg-canvas">
        <CanvasNotice>{error}</CanvasNotice>
      </div>
    );
  }

  const segTool = tool === "brush" || tool === "eraser" || tool === "wand";
  const gridClass =
    layout === "mpr"
      ? "grid-cols-3 grid-rows-1"
      : layout === "main"
        ? "grid-cols-[2fr_1fr] grid-rows-2"
        : layout === "mpr3d"
          ? "grid-cols-2 grid-rows-2"
          : "grid-cols-1 grid-rows-1";

  return (
    <div className="flex h-full w-full flex-col bg-canvas text-canvas-foreground">
      <ViewportBar>
        <BarLabel>{sequences.length > 1 ? "Sequence" : session.current?.modality ?? "Series"}</BarLabel>
        {sequences.length > 1 &&
          sequences.map((a) => (
            <BarButton
              key={a.key}
              label={<span className="uppercase tracking-wide">{a.label}</span>}
              title={`Show the ${a.label.toUpperCase()} sequence (camera and masks are kept)`}
              active={a.key === sequence}
              onClick={() => setSequence(a.key)}
            />
          ))}
        <BarSep />
        <BarSelect title="Layout" value={layout} options={LAYOUTS} onChange={setLayout} />
        {layout === "single" && (
          <BarSelect
            title="Plane"
            value={single}
            options={PLANES.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))}
            onChange={(p) => {
              setSingle(p);
              activeRef.current = p;
              setActiveCell(p);
            }}
          />
        )}
        <BarSep />
        <BarSelect
          title="Window / level"
          value=""
          options={[
            { value: "", label: "Window" },
            { value: "auto", label: "Auto (0.5–99.5%)" },
            { value: "full", label: "Full range" },
            ...(session.current?.modality === "CT" ? CT_PRESETS.map((p) => ({ value: p.id, label: `${p.label} ${p.window}/${p.level}` })) : []),
          ]}
          onChange={(v) => {
            if (v === "auto") autoVoi();
            else if (v === "full") fullVoi();
            else {
              const p = CT_PRESETS.find((x) => x.id === v);
              if (p) forMpr((vp) => setVoi(vp, wlToRange(p.window, p.level)));
            }
          }}
        />
        <BarButton icon={Contrast} title="Invert (Shift+I)" active={(() => { const vp = viewReady ? activeVp() : undefined; return vp ? getInvert(vp) : false; })()} onClick={() => forMpr((vp) => setInvert(vp, !getInvert(vp)))} />
        <BarButton icon={FlipHorizontal2} title="Flip active view horizontally (Shift+H)" onClick={() => onActive((vp) => flip(vp, "h"))} />
        <BarButton icon={FlipVertical2} title="Flip active view vertically (Shift+V)" onClick={() => onActive((vp) => flip(vp, "v"))} />
        <BarButton icon={RotateCcw} title="Rotate active view 90° left (Shift+L)" onClick={() => onActive((vp) => rotate(vp, -90))} />
        <BarButton icon={RotateCw} title="Rotate active view 90° right (Shift+R)" onClick={() => onActive((vp) => rotate(vp, 90))} />
        <BarButton icon={Maximize} title="Reset views (=)" onClick={resetAll} />
        <BarSelect
          title="Color map"
          value={colormap}
          options={COLORMAPS}
          onChange={(name) => {
            setColormapName(name);
            forMpr((vp) => setColormap(vp, name));
          }}
        />
        <BarButton
          label={linear ? "Smooth" : "Voxels"}
          title="Interpolation: smooth (linear) or nearest-neighbour voxels"
          active={!linear}
          onClick={() => {
            setLinear(!linear);
            forMpr((vp) => setInterpolation(vp, !linear));
          }}
        />
        <BarButton icon={Layers} label="MIP" title="Maximum-intensity projection over a 10 mm slab" active={mip} onClick={toggleMip} />
        <BarSep />
        {segAsset && (
          <>
            <BarButton
              icon={showRef ? Eye : EyeOff}
              label="Reference mask"
              title="Show the dataset's reference segmentation (read-only outline)"
              active={showRef && refReady}
              disabled={!refReady}
              onClick={() => setShowRef((v) => !v)}
            />
            <BarButton icon={Copy} label="Copy to my mask" title="Create editable masks from the reference segmentation (replaces your masks for those labels)" disabled={!refReady} onClick={copyReference} />
          </>
        )}
        <BarButton icon={Search} label="Magnify" title="Magnifier: 3× loupe under the cursor (M)" active={magnify} onClick={() => setMagnify((m) => !m)} />
        {tool === "wand" && (
          <>
            <BarSep />
            <BarButton label="Similar intensity" title="Fill: flood the connected region on this slice within ±8% of the window" active={wandMode === "flood"} onClick={() => setWandMode("flood")} />
            <BarButton icon={Fill} label="Smart fill" title="Smart fill: 3D adaptive region growing from the clicked structure's own intensity statistics (confidence-connected, no AI model)" active={wandMode === "smart"} onClick={() => setWandMode("smart")} />
          </>
        )}
        {segTool && (
          <>
            <BarSep />
            <BarButton icon={Wand2} label="Interpolate" title={`Fill slices between painted ${activeCell} slices of the active label`} disabled={!!busy} onClick={interpolate} />
            <BarButton icon={Sparkles} label="Remove islands" title="Keep only the largest connected region of the active label" disabled={!!busy} onClick={removeMaskIslands} />
            {tool !== "wand" && <BarButton icon={Box} label="3D brush" title="Paint a sphere through neighbouring slices instead of a circle" active={sphere} onClick={() => setSphere((v) => !v)} />}
          </>
        )}
        {busy && <span className="ml-auto text-[11px] text-canvas-foreground/60">Working…</span>}
      </ViewportBar>
      <div ref={gridRef} className={cn("relative grid min-h-0 flex-1 gap-px bg-white/10", gridClass)}>
        {cells.map((cell, i) => {
          const inf = info(cell);
          const r = readout.current?.cell === cell ? readout.current : null;
          return (
            <div
              key={`${layout}-${cell}`}
              className={cn(
                "relative min-h-0 min-w-0 bg-black",
                layout === "main" && i === 0 && "row-span-2",
                cell !== "3d" && cell === activeCell && cells.length > 1 && "outline outline-1 -outline-offset-1 outline-primary/60",
              )}
            >
              <div
                ref={(el) => {
                  cellEls.current[cell] = el;
                }}
                className="absolute inset-0"
                onContextMenu={(e) => e.preventDefault()}
                data-testid={cell === "3d" ? "volume-3d" : `plane-${cell}`}
              />
              {inf && (
                <>
                  <OrientationMarkers {...inf.markers} />
                  <CornerText
                    tl={<div className="uppercase tracking-wide">{cell}</div>}
                    tr={<div>{inf.slice} / {inf.total}</div>}
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
              {cell === "3d" && viewReady && <CornerText tl={<div className="uppercase tracking-wide">3D · MR preset</div>} br={<div>Drag to rotate</div>} />}
            </div>
          );
        })}
        <TextPrompt request={prompt} onDone={() => setPrompt(null)} />
        <Loupe root={gridRef.current} enabled={magnify && viewReady} />
        {(status === "loading" || !viewReady) && <CanvasNotice>Decoding volume…</CanvasNotice>}
      </div>
    </div>
  );
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
    console.warn("[inkling] reference style", e);
  }
  for (const id of viewportIds) {
    try {
      tools.segmentation.config.visibility.setSegmentationRepresentationVisibility(id, { segmentationId: s.refSegmentationId, type: LABELMAP }, visible);
    } catch {
      /* representation not on this viewport */
    }
  }
}

export { Volume3DViewer };
