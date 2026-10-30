import { labelNames } from "@studio/contracts/environment";
import { eventTarget, type Types } from "@cornerstonejs/core";
import simplify from "simplify-js";
import * as tools from "@cornerstonejs/tools";
import { hslToRgb, resolveLabelColor, resolveToken } from "@studio/plugin-ui-sdk/labels";
import type { Annotation, Geometry, MeasurementKind, Project } from "@studio/contracts/types";
import { setLiveStats, clearLiveStats } from "./liveStats";
import { decodeMaskInto, encodeMask, maskId, sameCounts } from "./rle";
import { T } from "./init";
import { RES } from "@studio/contracts/naming";
import { isEditable, LOCAL_AUTHOR, type Tool, useHost, visibleFor } from "@studio/plugin-ui-sdk";

type CsAnnotation = tools.Types.Annotation;
const { Events, SegmentationRepresentations } = tools.Enums;
const annState = tools.annotation.state;

/** Store tool → Cornerstone tool (or tool-instance) name. */
export const CS_TOOL: Partial<Record<Tool, string>> = {
  pan: tools.PanTool.toolName,
  zoom: tools.ZoomTool.toolName,
  windowLevel: tools.WindowLevelTool.toolName,
  crosshairs: tools.CrosshairsTool.toolName,
  box: tools.RectangleROITool.toolName,
  ellipse: tools.EllipticalROITool.toolName,
  polygon: T.Polygon,
  freehand: tools.PlanarFreehandROITool.toolName,
  keypoint: T.Keypoint,
  point: T.Keypoint,
  length: tools.LengthTool.toolName,
  angle: tools.AngleTool.toolName,
  cobb: tools.CobbAngleTool.toolName,
  bidirectional: tools.BidirectionalTool.toolName,
  probe: tools.ProbeTool.toolName,
  arrow: tools.ArrowAnnotateTool.toolName,
  brush: T.Brush,
  eraser: T.Eraser,
};

/** Annotation (measurement) tools whose drawings are synced with the store. */
export const ANNOTATION_TOOLS = [
  tools.RectangleROITool.toolName,
  tools.EllipticalROITool.toolName,
  T.Polygon,
  tools.PlanarFreehandROITool.toolName,
  T.Keypoint,
  tools.LengthTool.toolName,
  tools.AngleTool.toolName,
  tools.CobbAngleTool.toolName,
  tools.BidirectionalTool.toolName,
  tools.ProbeTool.toolName,
  tools.ArrowAnnotateTool.toolName,
];

export const KIND_TOOL: Record<MeasurementKind, string> = {
  length: tools.LengthTool.toolName,
  angle: tools.AngleTool.toolName,
  cobb: tools.CobbAngleTool.toolName,
  bidirectional: tools.BidirectionalTool.toolName,
  probe: tools.ProbeTool.toolName,
  arrow: tools.ArrowAnnotateTool.toolName,
  "ellipse-roi": tools.EllipticalROITool.toolName,
  "rectangle-roi": tools.RectangleROITool.toolName,
  "freehand-roi": tools.PlanarFreehandROITool.toolName,
};

export const TOOL_KIND: Record<string, MeasurementKind> = {
  ...Object.fromEntries(Object.entries(KIND_TOOL).map(([k, v]) => [v, k as MeasurementKind])),
  [T.Polygon]: "freehand-roi",
  [T.Keypoint]: "probe",
};

/** What a converter hands Cornerstone for one store annotation. */
export interface CsSpec {
  toolName: string;
  /** World points (handles, or the contour polyline for freehand). */
  points: Types.Point3[];
  metadata: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface Converter {
  toCs(a: Annotation): CsSpec | null;
  /** Geometry for a Cornerstone annotation; `attributes` are merged on creation. */
  fromCs(ann: CsAnnotation): { geometry: Geometry; attributes?: Annotation["attributes"] } | null;
}

export interface LabelmapAccess {
  segmentationId: string;
  dims: number[];
  /** Physical size of one voxel (mm³); 0 when unknown (pixels). */
  voxelMm3: number;
  read(): ArrayLike<number>;
  /** Set changed voxels and notify Cornerstone. */
  write(next: ArrayLike<number>): void;
  /** Image intensities on the same grid (for mean stats), if cheap to get. */
  intensity?(): ArrayLike<number> | null;
}

export interface BridgeOptions {
  project: Project;
  itemId: string;
  converter: Converter;
  /** Placement (frame/slice/plane) info is part of geometry; this decides which annotations we own. */
  owns(a: Annotation): boolean;
  labelmap: LabelmapAccess | null;
  viewportIds(): string[];
  /** Belongs-to-this-viewer test for Cornerstone annotations created by the user. */
  accepts(ann: CsAnnotation): boolean;
}

interface Owned {
  geometry: Geometry;
  label: string;
  provenance: string;
  locked: boolean;
}

export function labelRgb(labels: string[], label: string): [number, number, number] {
  return hslToRgb(resolveLabelColor(labels, label, 1)).map(Math.round) as [number, number, number];
}

/** Freehand contours arrive densely resampled; keep the shape within `tolerance`. */
export function simplifyPolyline<T extends number[]>(points: T[], tolerance: number, toXY: (p: T) => [number, number]): T[] {
  if (points.length < 8) return points;
  const tagged = points.map((p, i) => {
    const [x, y] = toXY(p);
    return { x, y, i };
  });
  const kept = simplify(tagged, tolerance, true) as typeof tagged;
  return kept.map((k) => points[k.i]);
}

export function round(v: number, d = 2) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** Numeric cached stats of the first target, flattened. */
export function readStats(ann: CsAnnotation): { stats: Record<string, number>; unit?: string; areaUnit?: string; modalityUnit?: string } {
  const cached = ann.data.cachedStats as Record<string, Record<string, unknown>> | undefined;
  const first = cached ? Object.values(cached)[0] : undefined;
  const stats: Record<string, number> = {};
  let unit: string | undefined, areaUnit: string | undefined, modalityUnit: string | undefined;
  if (first && typeof first === "object") {
    for (const [k, v] of Object.entries(first)) {
      if (typeof v === "number" && Number.isFinite(v)) stats[k] = round(v, 3);
      else if (Array.isArray(v) && typeof v[0] === "number" && k !== "index" && k !== "pointsInShape") stats[k] = round(v[0], 3);
    }
    unit = (first.unit ?? first.lengthUnits ?? first.radiusUnit) as string | undefined;
    areaUnit = first.areaUnit as string | undefined;
    modalityUnit = first.modalityUnit as string | undefined;
    if (!unit && typeof first.length === "number") unit = "mm";
  }
  return { stats, unit, areaUnit, modalityUnit };
}

const PASSIVE_CHANGES = new Set<string>([
  tools.Enums.ChangeTypes.StatsUpdated,
  tools.Enums.ChangeTypes.InitialSetup,
  tools.Enums.ChangeTypes.MetadataReferenceModified,
]);

/** Coordinates are stored rounded to 0.01; anything below this is not an edit. */
const EPS = 0.02;

function pointsEqual(a: number[][], b: number[][], eps = EPS) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    for (let d = 0; d < a[i].length; d++) if (Math.abs(a[i][d] - (b[i]?.[d] ?? NaN)) > eps) return false;
  }
  return true;
}

/** True when two geometries differ in shape or text (stats-only changes don't count). */
export function geometryChanged(a: Geometry, b: Geometry): boolean {
  if (a.type !== b.type) return true;
  const strip = (g: Geometry) => {
    const { stats: _s, unit: _u, ...rest } = g as Geometry & { stats?: unknown; unit?: unknown };
    return rest;
  };
  const ra = strip(a) as Record<string, unknown>;
  const rb = strip(b) as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    const va = ra[k], vb = rb[k];
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (Array.isArray(va[0])) {
        if (!pointsEqual(va as number[][], vb as number[][])) return true;
      } else if (!pointsEqual([va as number[]], [vb as number[]])) return true;
    } else if (typeof va === "number" && typeof vb === "number") {
      if (Math.abs(va - vb) > EPS) return true;
    } else if (va !== vb) return true;
  }
  return false;
}

function buildCsAnnotation(spec: CsSpec, uid: string, label: string): CsAnnotation {
  const isContour = spec.toolName === tools.PlanarFreehandROITool.toolName;
  const isSpline = spec.toolName === T.Polygon;
  const zero: Types.Point3 = [0, 0, 0];
  const data: Record<string, unknown> = {
    handles: {
      points: isContour ? [] : spec.points.map((p) => [...p] as Types.Point3),
      activeHandleIndex: null,
      textBox: {
        hasMoved: false,
        worldPosition: [...zero],
        worldBoundingBox: { topLeft: [...zero], topRight: [...zero], bottomLeft: [...zero], bottomRight: [...zero] },
      },
    },
    cachedStats: {},
    label,
    ...spec.data,
  };
  if (isContour) data.contour = { polyline: spec.points.map((p) => [...p]), closed: true };
  if (isSpline) {
    data.spline = { type: "LINEAR" };
    data.contour = { closed: true };
  }
  return {
    annotationUID: uid,
    highlighted: false,
    invalidated: true,
    isLocked: false,
    isVisible: true,
    autoGenerated: false,
    metadata: { ...spec.metadata, toolName: spec.toolName } as CsAnnotation["metadata"],
    data: data as CsAnnotation["data"],
  };
}

/**
 * Two-way sync between the studio store (source of truth) and Cornerstone's annotation
 * and segmentation state for one item. Created once per viewer mount; views (rendering
 * engines / viewports) may come and go underneath it.
 */
export class CornerstoneBridge {
  private owned = new Map<string, Owned>();
  private lastMask = new Map<string, Geometry | undefined>();
  private suppress = 0;
  private modifiedQueue = new Set<string>();
  private modifiedTimer: number | null = null;
  private maskTimer: number | null = null;
  private unsub: (() => void) | null = null;
  private disposed = false;
  private labels: string[];

  constructor(private o: BridgeOptions) {
    this.labels = labelNames(o.project.labels);
  }

  start() {
    eventTarget.addEventListener(Events.ANNOTATION_COMPLETED, this.onCompleted);
    eventTarget.addEventListener(Events.ANNOTATION_MODIFIED, this.onModified);
    eventTarget.addEventListener(Events.ANNOTATION_REMOVED, this.onRemoved);
    eventTarget.addEventListener(Events.ANNOTATION_SELECTION_CHANGE, this.onSelection);
    eventTarget.addEventListener(Events.SEGMENTATION_DATA_MODIFIED, this.onSegData);
    this.unsub = useHost.subscribe((s, prev) => {
      if (s.annotations !== prev.annotations || s.hiddenLabels !== prev.hiddenLabels || s.lockedLabels !== prev.lockedLabels) {
        this.reconcile();
      }
      if (s.selectedIds !== prev.selectedIds || s.selectedId !== prev.selectedId) this.syncSelection();
      if (s.overlayOpacity !== prev.overlayOpacity || s.outlineOnly !== prev.outlineOnly) this.applySegStyle();
    });
    this.reconcile();
    this.syncSelection();
  }

  dispose() {
    for (const uid of [...this.pending.keys()]) this.commitPending(uid);
    this.flushModified();
    this.flushMasks();
    this.disposed = true;
    eventTarget.removeEventListener(Events.ANNOTATION_COMPLETED, this.onCompleted);
    eventTarget.removeEventListener(Events.ANNOTATION_MODIFIED, this.onModified);
    eventTarget.removeEventListener(Events.ANNOTATION_REMOVED, this.onRemoved);
    eventTarget.removeEventListener(Events.ANNOTATION_SELECTION_CHANGE, this.onSelection);
    eventTarget.removeEventListener(Events.SEGMENTATION_DATA_MODIFIED, this.onSegData);
    this.unsub?.();
    this.silently(() => {
      for (const uid of this.owned.keys()) annState.removeAnnotation(uid);
    });
    clearLiveStats(this.owned.keys());
    this.owned.clear();
  }

  private silently(fn: () => void) {
    this.suppress++;
    try {
      fn();
    } finally {
      this.suppress--;
    }
  }

  private render() {
    const ids = this.o.viewportIds();
    if (ids.length) tools.utilities.triggerAnnotationRenderForViewportIds(ids);
  }

  // ---------------------------------------------------------------- Cornerstone → store

  private onCompleted = (evt: Event) => {
    const ann = (evt as CustomEvent<{ annotation: CsAnnotation }>).detail.annotation;
    if (this.suppress || !ann?.annotationUID || !this.o.accepts(ann)) return;
    if (!ANNOTATION_TOOLS.includes(ann.metadata?.toolName ?? "")) return;
    const s = useHost.getState();
    const uid = ann.annotationUID;
    if (s.annotations.some((a) => a.id === uid) || this.pending.has(uid)) return;
    const label = s.activeLabel ?? this.labels[0] ?? "finding";
    // ArrowAnnotate keeps its note in data.label; other tools show the class name.
    if (ann.metadata?.toolName !== tools.ArrowAnnotateTool.toolName) ann.data.label = label;
    // Cornerstone computes stats (probe value, ROI mean…) on the render after completion;
    // commit once they arrive (or shortly after) so the store gets them in the same undo step.
    this.pending.set(uid, { label, timer: window.setTimeout(() => this.commitPending(uid), 400) });
  };

  private pending = new Map<string, { label: string; timer: number }>();

  private commitPending(uid: string) {
    const p = this.pending.get(uid);
    if (!p) return;
    window.clearTimeout(p.timer);
    this.pending.delete(uid);
    const ann = annState.getAnnotation(uid);
    if (!ann || this.disposed) return;
    const converted = this.o.converter.fromCs(ann);
    if (!converted) return;
    const s = useHost.getState();
    const a: Annotation = {
      id: uid,
      itemId: this.o.itemId,
      label: p.label,
      geometry: converted.geometry,
      provenance: "human-created",
      author: LOCAL_AUTHOR,
      createdAt: new Date().toISOString(),
      ...(converted.attributes ? { attributes: converted.attributes } : {}),
    };
    this.owned.set(uid, { geometry: a.geometry, label: a.label, provenance: a.provenance, locked: false });
    this.styleAnnotation(a);
    setLiveStats(uid, readStats(ann));
    s.add(a);
    s.select(uid);
  }

  private onModified = (evt: Event) => {
    const { annotation: ann, changeType } = (evt as CustomEvent<{ annotation: CsAnnotation; changeType?: string }>).detail;
    const uid = ann?.annotationUID;
    if (uid && this.pending.has(uid)) {
      if (changeType === tools.Enums.ChangeTypes.StatsUpdated && Object.keys(readStats(ann).stats).length) this.commitPending(uid);
      return;
    }
    if (!uid || !this.owned.has(uid)) return;
    setLiveStats(uid, readStats(ann));
    // Stats recomputation (e.g. on first render) is not an edit; never write it back.
    if (this.suppress || (changeType && PASSIVE_CHANGES.has(changeType))) return;
    this.modifiedQueue.add(uid);
    if (this.modifiedTimer) window.clearTimeout(this.modifiedTimer);
    this.modifiedTimer = window.setTimeout(() => this.flushModified(), 300);
  };

  /** Write pending handle edits to the store (also called on mouse-up). */
  flushModified() {
    if (this.modifiedTimer) window.clearTimeout(this.modifiedTimer);
    this.modifiedTimer = null;
    if (this.disposed) return;
    const s = useHost.getState();
    for (const uid of this.modifiedQueue) {
      const ann = annState.getAnnotation(uid);
      const current = s.annotations.find((a) => a.id === uid);
      if (!ann || !current) continue;
      const converted = this.o.converter.fromCs(ann);
      if (!converted || !geometryChanged(current.geometry, converted.geometry)) continue;
      if (!isEditable(current, s.lockedLabels)) continue;
      const owned = this.owned.get(uid)!;
      this.owned.set(uid, { ...owned, geometry: converted.geometry });
      useHost.getState().update(uid, { geometry: converted.geometry });
      const after = useHost.getState().annotations.find((a) => a.id === uid);
      if (after) this.owned.set(uid, { ...owned, geometry: after.geometry, provenance: after.provenance });
    }
    this.modifiedQueue.clear();
  }

  private onRemoved = (evt: Event) => {
    const ann = (evt as CustomEvent<{ annotation: CsAnnotation }>).detail.annotation;
    const uid = ann?.annotationUID;
    if (uid && this.pending.has(uid)) {
      window.clearTimeout(this.pending.get(uid)!.timer);
      this.pending.delete(uid);
      return;
    }
    if (this.suppress || !uid || !this.owned.has(uid)) return;
    this.owned.delete(uid);
    const s = useHost.getState();
    if (s.annotations.some((a) => a.id === uid)) s.remove(uid);
  };

  private onSelection = (evt: Event) => {
    if (this.suppress) return;
    const { selection } = (evt as CustomEvent<{ selection: string[] }>).detail;
    const s = useHost.getState();
    const mine = selection.filter((uid) => this.owned.has(uid));
    // Keep selections Cornerstone doesn't know about (masks, other items) and the order the
    // expert picked things in; newly selected ids go last so the last click is primary.
    const kept = s.selectedIds.filter((id) => !this.owned.has(id) || mine.includes(id));
    const next = [...kept, ...mine.filter((id) => !kept.includes(id))];
    if (next.length === s.selectedIds.length && next.every((id, i) => id === s.selectedIds[i])) return;
    s.selectMany(next);
  };

  /** ⌘/Ctrl-click toggles an annotation in the selection (Cornerstone itself only knows Shift). */
  toggleAt(element: HTMLElement, canvas: [number, number]): boolean {
    const near = tools.utilities.getAnnotationNearPoint(element as HTMLDivElement, canvas as Types.Point2, 8);
    const uid = near?.annotationUID;
    if (!uid || !this.owned.has(uid)) return false;
    useHost.getState().toggleSelect(uid);
    return true;
  }

  // ---------------------------------------------------------------- store → Cornerstone

  private syncSelection() {
    const want = useHost.getState().selectedIds.filter((id) => this.owned.has(id));
    const selected = tools.annotation.selection.getAnnotationsSelected().filter((uid) => this.owned.has(uid));
    const same = want.length === selected.length && want.every((id) => selected.includes(id));
    if (!same) {
      this.silently(() => {
        for (const uid of selected) if (!want.includes(uid)) tools.annotation.selection.setAnnotationSelected(uid, false, true);
        for (const uid of want) if (!selected.includes(uid)) tools.annotation.selection.setAnnotationSelected(uid, true, true);
      });
    }
    this.render();
  }

  private styleAnnotation(a: Annotation) {
    const ai = a.provenance === "ai-suggested";
    const color = ai ? resolveToken("--prov-ai") : resolveLabelColor(this.labels, a.label);
    tools.annotation.config.style.setAnnotationStyles(a.id, {
      color,
      colorHighlighted: color,
      colorSelected: "rgb(255, 255, 255)",
      colorLocked: color,
      lineDash: ai ? "6,4" : "",
      lineWidth: 1.5,
      lineWidthSelected: 2.5,
      textBoxColor: color,
      textBoxColorSelected: "rgb(255, 255, 255)",
      // Hover keeps the label colour (Cornerstone's default hover text is green).
      textBoxColorHighlighted: color,
    } as Parameters<typeof tools.annotation.config.style.setAnnotationStyles>[1]);
  }

  /** Bring Cornerstone in line with the store for this item (idempotent). */
  reconcile() {
    if (this.disposed) return;
    const s = useHost.getState();
    const mine = s.annotations.filter((a) => a.itemId === this.o.itemId);
    const visible = new Set(visibleFor(mine, this.o.itemId, s.hiddenLabels).map((a) => a.id));
    const desired = new Map<string, Annotation>();
    for (const a of mine) if (visible.has(a.id) && a.geometry.type !== "mask" && this.o.owns(a)) desired.set(a.id, a);

    let changed = false;
    this.silently(() => {
      for (const uid of [...this.owned.keys()]) {
        if (!desired.has(uid)) {
          if (annState.getAnnotation(uid)) annState.removeAnnotation(uid);
          this.owned.delete(uid);
          changed = true;
        }
      }
      for (const a of desired.values()) {
        const prev = this.owned.get(a.id);
        const locked = !isEditable(a, s.lockedLabels);
        const exists = !!annState.getAnnotation(a.id);
        if (prev && exists && prev.geometry === a.geometry) {
          if (prev.label !== a.label || prev.provenance !== a.provenance || prev.locked !== locked) {
            const ann = annState.getAnnotation(a.id);
            if (ann && ann.metadata?.toolName !== tools.ArrowAnnotateTool.toolName) ann.data.label = a.label;
            this.styleAnnotation(a);
            tools.annotation.locking.setAnnotationLocked(a.id, locked);
            this.owned.set(a.id, { geometry: a.geometry, label: a.label, provenance: a.provenance, locked });
            changed = true;
          }
          continue;
        }
        if (exists) annState.removeAnnotation(a.id);
        const spec = this.o.converter.toCs(a);
        if (!spec) continue;
        const ann = buildCsAnnotation(spec, a.id, a.label);
        try {
          annState.addAnnotation(ann, (spec.metadata.FrameOfReferenceUID as string) ?? "");
        } catch (e) {
          console.warn(`[${RES}] could not show annotation`, a.id, e);
          continue;
        }
        this.styleAnnotation(a);
        if (locked) tools.annotation.locking.setAnnotationLocked(a.id, true);
        this.owned.set(a.id, { geometry: a.geometry, label: a.label, provenance: a.provenance, locked });
        changed = true;
      }
    });
    this.reconcileMasks();
    if (changed) {
      this.syncSelection();
      this.render();
    }
  }

  // ---------------------------------------------------------------- masks

  segmentIndex(label: string) {
    return this.labels.indexOf(label) + 1;
  }

  private maskFor(label: string): Annotation | undefined {
    const list = useHost.getState().annotations;
    const id = maskId(this.o.itemId, label);
    return (
      list.find((a) => a.id === id) ??
      list.find((a) => a.itemId === this.o.itemId && a.geometry.type === "mask" && a.label === label)
    );
  }

  /** Decode store masks into the labelmap where they differ from what we last synced. */
  reconcileMasks(force = false) {
    const lm = this.o.labelmap;
    if (!lm) return;
    const changed: { label: string; mask?: Annotation }[] = [];
    for (const label of this.labels) {
      const mask = this.maskFor(label);
      if (force || mask?.geometry !== this.lastMask.get(label)) changed.push({ label, mask });
    }
    if (changed.length) {
      const current = lm.read();
      const next = new Uint8Array(current.length);
      for (let i = 0; i < current.length; i++) next[i] = current[i];
      for (const { label, mask } of changed) {
        const seg = this.segmentIndex(label);
        for (let i = 0; i < next.length; i++) if (next[i] === seg) next[i] = 0;
        if (mask && mask.geometry.type === "mask") decodeMaskInto(mask.geometry.counts, next, seg);
        this.lastMask.set(label, mask?.geometry);
      }
      this.silently(() => lm.write(next));
    }
    this.applySegStyle();
  }

  private onSegData = (evt: Event) => {
    const { segmentationId } = (evt as CustomEvent<{ segmentationId: string }>).detail;
    if (this.suppress || !this.o.labelmap || segmentationId !== this.o.labelmap.segmentationId) return;
    if (this.maskTimer) window.clearTimeout(this.maskTimer);
    this.maskTimer = window.setTimeout(() => this.flushMasks(), 350);
  };

  /** Encode the labelmap into one mask annotation per label and write changes to the store. */
  flushMasks() {
    if (this.maskTimer) window.clearTimeout(this.maskTimer);
    const pending = this.maskTimer !== null;
    this.maskTimer = null;
    const lm = this.o.labelmap;
    if (!pending || !lm || this.disposed) return;
    const data = lm.read();
    const intensity = lm.intensity?.() ?? null;
    const s = useHost.getState();
    for (const label of this.labels) {
      const seg = this.segmentIndex(label);
      const { counts, voxels } = encodeMask(data, seg);
      const existing = this.maskFor(label);
      const prev = existing?.geometry.type === "mask" ? existing.geometry : undefined;
      if (!existing && voxels === 0) continue;
      if (prev && sameCounts(prev.counts, counts)) continue;
      if (existing && !isEditable(existing, s.lockedLabels)) continue;
      if (voxels === 0 && existing) {
        this.lastMask.set(label, undefined);
        useHost.getState().remove(existing.id);
        continue;
      }
      const geometry: Geometry = {
        type: "mask",
        dims: lm.dims,
        counts,
        voxels,
        ...(lm.voxelMm3 ? { volumeMm3: round(voxels * lm.voxelMm3, 1) } : {}),
      };
      const id = existing?.id ?? maskId(this.o.itemId, label);
      if (intensity) setLiveStats(id, { stats: maskIntensity(data, seg, intensity) });
      // Record before writing: the store update re-enters reconcile() synchronously.
      this.lastMask.set(label, geometry);
      if (existing) {
        useHost.getState().update(existing.id, { geometry });
      } else {
        const now = new Date().toISOString();
        useHost.getState().upsert({
          id,
          itemId: this.o.itemId,
          label,
          geometry,
          provenance: "human-created",
          author: LOCAL_AUTHOR,
          createdAt: now,
        });
      }
    }
  }

  /** Mark the labelmap as changed by code (wand, island removal…) and sync it now. */
  labelmapEdited() {
    this.maskTimer = this.maskTimer ?? window.setTimeout(() => this.flushMasks(), 0);
  }

  /** Per-viewport segment colors, visibility, locks and fill style. */
  applySegStyle() {
    const lm = this.o.labelmap;
    if (!lm) return;
    const s = useHost.getState();
    const segId = lm.segmentationId;
    const type = SegmentationRepresentations.Labelmap;
    try {
      tools.segmentation.config.style.setStyle(
        { segmentationId: segId, type },
        {
          renderFill: !s.outlineOnly,
          fillAlpha: 0.5 * s.overlayOpacity,
          fillAlphaInactive: 0.35 * s.overlayOpacity,
          renderOutline: true,
          outlineWidth: s.outlineOnly ? 2 : 1,
          outlineOpacity: Math.max(0.3, s.overlayOpacity),
        },
      );
    } catch (e) {
      console.warn(`[${RES}] segmentation style`, e);
    }
    for (const label of this.labels) {
      const seg = this.segmentIndex(label);
      const mask = this.maskFor(label);
      const hidden = s.hiddenLabels.includes(label) || !!mask?.hidden;
      const locked = s.lockedLabels.includes(label) || !!mask?.locked;
      try {
        tools.segmentation.segmentLocking.setSegmentIndexLocked(segId, seg, locked);
      } catch {
        /* segmentation not yet registered */
      }
      for (const vp of this.o.viewportIds()) {
        try {
          tools.segmentation.config.visibility.setSegmentIndexVisibility(vp, { segmentationId: segId, type }, seg, !hidden);
        } catch {
          /* viewport without this representation */
        }
      }
    }
  }

  /** Color LUT for segment index = label index + 1. */
  colorLUT(alpha = 255): Types.ColorLUT {
    return [[0, 0, 0, 0], ...this.labels.map((l) => [...labelRgb(this.labels, l), alpha] as Types.Color)];
  }
}

function maskIntensity(data: ArrayLike<number>, seg: number, intensity: ArrayLike<number>): Record<string, number> {
  let n = 0, sum = 0, sq = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== seg) continue;
    const v = intensity[i];
    n++;
    sum += v;
    sq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!n) return {};
  const mean = sum / n;
  return { mean: round(mean, 2), stdDev: round(Math.sqrt(Math.max(0, sq / n - mean * mean)), 2), min: round(min, 2), max: round(max, 2) };
}
