import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadVolume, type Volume } from "@/kits/io/nifti";
import { CLOSE_RADIUS } from "@/kits/overlay2d/draw";
import { hitVertex, pointInPolygon, polygonArea, rleDecode, rleEncode, rleForeground } from "@/kits/overlay2d/geometry";
import { useViewport2D } from "@/kits/overlay2d/useViewport2D";
import { CanvasNotice } from "@/kits/viewport-chrome/CanvasNotice";
import { Legend } from "@/kits/viewport-chrome/legend";
import { rangeBounds, Transport, useFramePlayback, type FrameRange, type PlayMode } from "@/kits/viewport-chrome/transport";
import { useCanvasSize } from "@/kits/viewport-chrome/useCanvasSize";
import { hslToRgb, labelColor, resolveLabelColor, resolveToken } from "@/lib/labels";
import { commandDef, commandId, registerCommand, useCommands } from "@/platform/commands";
import { labelNames } from "@/platform/environment";
import { matches } from "@/platform/keys";
import type { RendererProps } from "@/platform/module";
import { brushSizeOf, isEditable, newAnnotation, toolOption, useStudio } from "@/stores/studio";
import type { Annotation, Pt } from "@/types";
import { CineConfigSchema } from "../config";
import {
  cellKey,
  frameCoverage,
  groupCells,
  isContour,
  isMask,
  isPhase,
  labelValue,
  phaseOps,
  referenceSlices,
  resolvePhases,
  ring,
  toControlPoints,
  type ContourAnn,
  type Grid,
  type MaskAnn,
} from "../model";
import { SliceFrameMatrix } from "../panels/sliceFrameMatrix";
import { CINE, GOTO_COMMAND, RUNTIME, structuresOf, type CineGrid, type CinePlayhead, type RefSeg } from "../public";
import { CineToolbar } from "./CineToolbar";
import { copyCell, importReference, interpolateCells, type EditResult } from "./edits";
import { dragMove, dragVertex, drawScene, edgeInsertIndex, EMPTY_CELL, pickAt, round2, stamp, type Drag, type PaintDrag } from "./engine";
import { fullRange, percentileWindow, renderLabelMap, renderSlice, type Rgb } from "./render";
import { ns } from "@studio/plugin-contracts/naming";

const SCOPE = [CINE, ns("core")];

/** Index of the key that fired `name` in its active binding (direction families such as ← → ↑ ↓), or -1. */
function keyIndex(e: KeyboardEvent | undefined, name: string): number {
  if (!e) return -1;
  return commandDef(commandId(name, SCOPE))?.keys.findIndex((k) => matches(e, k)) ?? -1;
}
/** [dz, df] per key of the copy commands, in manifest order: ← → ↑ ↓. */
const COPY_DIRS: [number, number][] = [[0, -1], [0, 1], [-1, 0], [1, 0]];

/**
 * React host of the slice × frame renderer: loads the cine and its reference volumes,
 * owns view state, wires pointer and command input to the engine (engine.ts, edits.ts) and
 * publishes `grid`, `playhead`, references and coverage to the runtime for inspectors and
 * panels (e.g. inkling.cardiac-metrics).
 */
export function CineHost({ project, item, config: rawConfig, runtime }: RendererProps) {
  const config = useMemo(() => CineConfigSchema.parse(rawConfig), [rawConfig]);
  const keyFrames = config.keyFrames;
  const keyIds = useMemo(() => keyFrames.map((k) => k.id), [keyFrames]);
  const cineAsset = item.assets.find((a) => a.role === "cine");
  const labels = useMemo(() => labelNames(project.labels), [project.labels]);
  const structs = useMemo(() => structuresOf(config), [config]);

  // ---- data ----
  const [cine, setCine] = useState<Volume | null>(null);
  const [refs, setRefs] = useState<RefSeg[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setCine(null);
    setError(null);
    if (!cineAsset) {
      setError("This study has no cine volume");
      return;
    }
    loadVolume(cineAsset.path)
      .then((v) => {
        if (!live) return;
        setCine(v);
        setSlice(v.dims[2] >> 1);
        const first = keyFrames[0] && item.assets.find((a) => a.role === "reference" && a.phase === keyFrames[0].id)?.frame;
        setFrame(first ?? 0);
      })
      .catch((e: Error) => live && setError(e.message));
    Promise.all(
      item.assets.filter((a) => a.role === "reference").map(async (a) => ({ frame: a.frame ?? 0, phase: a.phase ?? "", volume: await loadVolume(a.path) })),
    )
      .then((r) => live && setRefs(r))
      .catch(() => live && setRefs([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // ---- view state ----
  const [slice, setSlice] = useState(0);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(cineAsset?.fps ?? 20);
  const [mode, setMode] = useState<PlayMode>("loop");
  const [range, setRange] = useState<FrameRange>([null, null]);
  const [win, setWin] = useState<[number, number]>([0, 1]);
  const [invert, setInvert] = useState(false);
  const [smooth, setSmooth] = useState(true);
  const [showRef, setShowRef] = useState(true);
  // The matrix would squeeze the image on short screens; start it collapsed there.
  const [matrixOpen, setMatrixOpen] = useState(() => window.innerHeight >= 900);
  const [wrapCycle, setWrapCycle] = useState(false);
  const [draft, setDraft] = useState<Pt[]>([]);
  const [preview, setPreview] = useState<{ id: string; points: Pt[] } | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const drag = useRef<Drag | null>(null);
  /** Hold-to-pan: the physical key held (its `code`) and whether it was used to pan. */
  const hold = useRef<{ code: string | null; used: boolean }>({ code: null, used: false });

  const autoWin = useMemo<[number, number]>(() => (cine ? percentileWindow(cine.data, 1, 99) : [0, 1]), [cine]);
  const fullWin = useMemo<[number, number]>(() => (cine ? fullRange(cine.data) : [0, 1]), [cine]);
  useEffect(() => setWin(autoWin), [autoWin]);
  // Thumbnails follow the live window, regenerated once dragging settles.
  const [thumbWin, setThumbWin] = useState<[number, number]>([0, 1]);
  useEffect(() => {
    const t = setTimeout(() => setThumbWin(win), 250);
    return () => clearTimeout(t);
  }, [win]);

  const flash = useCallback((msg: string) => setNotice(msg), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- store ----
  const tool = useStudio((s) => s.tool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const annotations = useStudio((s) => s.annotations);
  const selectedId = useStudio((s) => s.selectedId);
  const selectedIds = useStudio((s) => s.selectedIds);
  const hiddenLabels = useStudio((s) => s.hiddenLabels);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const overlayOpacity = useStudio((s) => s.overlayOpacity);
  const brushSize = useStudio(brushSizeOf);
  const brushThreshold = useStudio((s) => toolOption(s, "brush", "threshold", false));
  const outlineOnly = useStudio((s) => s.outlineOnly);
  const { add, update, select, toggleSelect, batch, setViewerStatus, toggleLabelHidden } = useStudio.getState();

  const grid = useMemo<Grid | null>(
    () => (cine ? { nx: cine.dims[0], ny: cine.dims[1], nz: cine.dims[2], frames: cine.frames, spacing: cine.spacing } : null),
    [cine],
  );

  const nx = cine?.dims[0] ?? 0, ny = cine?.dims[1] ?? 0, nz = cine?.dims[2] ?? 1, nt = cine?.frames ?? 1;
  const dx = cine?.spacing[0] ?? 1, dy = cine?.spacing[1] ?? 1;

  const cells = useMemo(() => groupCells(annotations, item.id), [annotations, item.id]);
  const cell = cells.get(cellKey(slice, frame)) ?? EMPTY_CELL;
  const phases = useMemo(() => resolvePhases(annotations, item.id, item.assets, project.meta, keyIds), [annotations, item.id, item.assets, project.meta, keyIds]);
  /** frame → key frame id; the first configured key frame wins when two share a frame. */
  const keyFrameOf = useMemo(() => {
    const m = new Map<number, string>();
    for (const k of [...keyFrames].reverse()) {
      const f = phases[k.id]?.frame;
      if (f !== undefined) m.set(f, k.id);
    }
    return m;
  }, [keyFrames, phases]);
  const refSlices = useMemo(() => (grid ? new Map(refs.map((r) => [r.frame, referenceSlices(r.volume, labels, structs, grid)])) : undefined), [refs, labels, structs, grid]);
  const coverage = useMemo(
    () => (grid ? frameCoverage({ annotations, itemId: item.id, labels, structures: structs, grid, refSlices }) : null),
    [annotations, item.id, labels, structs, grid, refSlices],
  );
  const phaseRef = refs.find((r) => r.frame === frame);

  // ---- runtime (read by the inspector and panels) ----
  const cineGrid = useMemo<CineGrid | null>(() => (grid ? { ...grid, dims: [grid.nx, grid.ny, grid.nz] } : null), [grid]);
  useEffect(() => {
    if (cineGrid) runtime.publish(RUNTIME.grid, cineGrid);
  }, [cineGrid, runtime]);
  useEffect(() => runtime.publish(RUNTIME.references, refs), [refs, runtime]);
  useEffect(() => {
    if (coverage) runtime.publish(RUNTIME.coverage, coverage);
  }, [coverage, runtime]);
  const playhead = useMemo<CinePlayhead>(() => ({ frame, slice, time: frame / fps }), [frame, slice, fps]);
  useEffect(() => runtime.publish(RUNTIME.playhead, playhead), [playhead, runtime]);

  const visible = useCallback((a: Annotation) => !a.hidden && !hiddenLabels.includes(a.label), [hiddenLabels]);
  const editable = useCallback((a: Annotation) => isEditable(a, lockedLabels), [lockedLabels]);
  const selected = useMemo(
    () => [...cell.contours, ...cell.masks].find((a) => a.id === selectedId) as ContourAnn | MaskAnn | undefined,
    [cell, selectedId],
  );
  const selectedContour = selected && isContour(selected) && visible(selected) && editable(selected) ? selected : undefined;

  // ---- camera ----
  const { containerRef, canvasRef, size } = useCanvasSize();
  const content = useMemo(() => ({ width: nx * dx, height: ny * dy }), [nx, ny, dx, dy]);
  const vp = useViewport2D(content, size);
  const { camera, toScreen, toContent } = vp;
  const vs = useCallback((p: Pt): [number, number] => toScreen(p[0] * dx, p[1] * dy), [toScreen, dx, dy]);
  const hitR = 8 / (camera.scale * Math.min(dx, dy));

  // ---- playback ----
  const [rangeFrom, rangeTo] = rangeBounds(range, nt);
  useFramePlayback({ playing, fps, mode, from: rangeFrom, to: rangeTo, setFrame });

  // ---- navigation ----
  const stepFrame = useCallback((d: number) => setFrame((f) => (f + d + nt) % nt), [nt]);
  const stepSlice = useCallback((d: number) => setSlice((s) => Math.max(0, Math.min(nz - 1, s + d))), [nz]);
  const goto = useCallback((z: number, f: number) => {
    setPlaying(false);
    setSlice(z);
    setFrame(f);
  }, []);

  // Panels and the agent navigate with `inkling.cine.commands.goTo` ({ slice?, frame? }).
  const pos = useRef({ slice, frame });
  pos.current = { slice, frame };
  useEffect(
    () =>
      registerCommand(GOTO_COMMAND, (_e, args) => {
        const a = (args ?? {}) as { slice?: number; frame?: number };
        goto(a.slice ?? pos.current.slice, a.frame ?? pos.current.frame);
      }),
    [goto],
  );

  // A contour belongs to one frame and slice; moving away abandons it.
  useEffect(() => {
    setDraft([]);
    setPreview(null);
    drag.current = null;
  }, [frame, slice, tool]);

  // Selecting an annotation elsewhere (sidebar) navigates to it.
  useEffect(() => {
    if (!selectedId) return;
    const a = useStudio.getState().annotations.find((x) => x.id === selectedId);
    if (!a || a.itemId !== item.id) return;
    if (isContour(a) || isMask(a)) {
      setSlice(a.geometry.slice!);
      setFrame(a.geometry.frame!);
      setPlaying(false);
    } else if (isPhase(a)) setFrame(a.geometry.frame);
  }, [selectedId, item.id]);

  // ---- status bar ----
  useEffect(() => {
    if (!cine) return;
    const phase = keyFrameOf.has(frame) ? ` (${keyFrameOf.get(frame)})` : "";
    const w = win[1] - win[0], l = (win[0] + win[1]) / 2;
    setViewerStatus(
      `Slice ${slice + 1}/${nz} · Frame ${frame + 1}/${nt}${phase} · W ${w.toFixed(0)} L ${l.toFixed(0)} · ${Math.round(camera.scale * dx * 100)}% · ${dx.toFixed(2)}×${dy.toFixed(2)}×${cine.spacing[2].toFixed(1)} mm`,
    );
  }, [cine, slice, frame, keyFrameOf, win, camera.scale, dx, dy, nz, nt, setViewerStatus]);

  // ---- offscreen layers ----
  const baseCanvas = useRef<HTMLCanvasElement | null>(null);
  const maskCanvas = useRef<HTMLCanvasElement | null>(null);
  const refCanvas = useRef<HTMLCanvasElement | null>(null);
  const colorsByValue = useMemo<(Rgb | null)[]>(() => [null, ...labels.map((l) => hslToRgb(resolveLabelColor(labels, l)))], [labels]);

  const base = useMemo(() => (cine ? (baseCanvas.current = renderSlice(cine, slice, frame, win[0], win[1], invert, baseCanvas.current)) : null), [cine, slice, frame, win, invert]);
  const refLayer = useMemo(() => {
    if (!phaseRef || !showRef || !cine) return null;
    const hiddenVals = hiddenLabels.map((l) => labelValue(labels, l));
    const colors = colorsByValue.map((c, v) => (hiddenVals.includes(v) ? null : c));
    return (refCanvas.current = renderLabelMap(phaseRef.volume.data, slice * nx * ny, nx, ny, colors, 1, true, refCanvas.current));
  }, [phaseRef, showRef, cine, slice, nx, ny, colorsByValue, hiddenLabels, labels]);

  const d = drag.current;
  const paintKey = d?.kind === "paint" ? d : null;
  const maskLayer = useMemo(() => {
    const masks = cell.masks.filter(visible);
    if (!cine || (!masks.length && !paintKey)) return null;
    const map = new Uint8Array(nx * ny);
    const live = new Set(paintKey?.layers.map((l) => l.id));
    for (const m of masks) if (!live.has(m.id)) rleDecode(m.geometry.counts, nx * ny, map, labelValue(labels, m.label));
    for (const layer of paintKey?.layers ?? []) {
      const v = labelValue(labels, layer.label);
      for (let i = 0; i < map.length; i++) if (layer.buf[i]) map[i] = v;
    }
    return (maskCanvas.current = renderLabelMap(map, 0, nx, ny, colorsByValue, 0.45 * overlayOpacity, outlineOnly, maskCanvas.current));
    // `tick` re-renders the live brush stroke held in the drag ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cine, cell.masks, visible, paintKey, tick, nx, ny, labels, colorsByValue, overlayOpacity, outlineOnly]);

  // ---- draw ----
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !size.width || !cine || !base) return;
    const [x0, y0] = toScreen(0, 0);
    const dr = drag.current;
    drawScene(ctx, {
      size,
      vs,
      image: { x: x0, y: y0, w: nx * dx * camera.scale, h: ny * dy * camera.scale },
      smooth,
      base,
      refLayer,
      maskLayer,
      overlayOpacity,
      outlineOnly,
      contours: cell.contours.filter(visible),
      structs,
      preview,
      selectedIds,
      selectedId,
      editable,
      activeVertex: dr?.kind === "vertex" ? dr.index : -1,
      draft,
      freehand: dr?.kind === "freehand" ? dr.path : null,
      tool,
      activeLabel,
      hover,
      brushSize,
      color: (l, alpha) => resolveLabelColor(labels, l, alpha),
      token: (t) => resolveToken(t),
    });
  });

  // ---- editing helpers ----
  /** Commit a reshaped contour; a hand-edited copy/interpolation becomes a manual key contour. */
  const editContour = (a: ContourAnn, points: Pt[]) => {
    const src = a.attributes?.source;
    const attributes = src === "interpolated" || src === "copied" ? { ...a.attributes, source: "manual", derivedFrom: src } : a.attributes;
    update(a.id, { geometry: { ...a.geometry, points }, attributes });
  };

  const voxelAt = (e: { clientX: number; clientY: number }): Pt => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const [cx, cy] = toContent(e.clientX - rect.left, e.clientY - rect.top);
    return [cx / dx, cy / dy];
  };
  const inImage = (p: Pt) => p[0] >= 0 && p[1] >= 0 && p[0] <= nx && p[1] <= ny;

  const commitDraft = useCallback(
    (points: Pt[]) => {
      setDraft([]);
      if (points.length < 3 || !activeLabel) return;
      const type = tool === "polygon" ? "polygon" : "spline";
      const a = newAnnotation({ itemId: item.id, label: activeLabel, geometry: { type, points, frame, slice }, attributes: { source: "manual" } });
      add(a);
      select(a.id);
    },
    [activeLabel, tool, item.id, frame, slice, add, select],
  );

  const paint = (dr: PaintDrag, a: Pt, b: Pt) =>
    cine && stamp(dr, a, b, { radius: brushSize / 2 / (camera.scale * Math.min(dx, dy)), cine, slice, frame, threshold: brushThreshold ? win : null });

  // ---- pointer ----
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!cine) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.button === 1 || hold.current.code || tool === "pan") {
      if (hold.current.code) hold.current.used = true;
      vp.startPan(e);
      drag.current = { kind: "pan" };
      return;
    }
    if (e.button !== 0) return;
    const p = voxelAt(e);
    if (tool === "windowLevel") {
      drag.current = { kind: "wl", x: e.clientX, y: e.clientY, lo: win[0], hi: win[1] };
      return;
    }
    setPlaying(false); // editing pauses the cine
    if (tool === "select" || tool === "spline" || tool === "polygon") {
      const sel = selectedContour;
      if (sel && !e.shiftKey && (tool === "select" || !draft.length)) {
        const pts = sel.geometry.points;
        const vi = hitVertex(p, pts, hitR);
        if (vi >= 0) {
          if (e.altKey) {
            if (pts.length > 3) editContour(sel, pts.filter((_, i) => i !== vi));
            else flash("A contour needs at least 3 points; press Delete to remove it");
            return;
          }
          drag.current = { kind: "vertex", id: sel.id, index: vi, points: pts.slice() };
          return;
        }
        const ei = edgeInsertIndex(sel.geometry, p, hitR);
        if (ei >= 0 && !e.altKey) {
          const np = pts.slice();
          np.splice(ei, 0, round2(p));
          drag.current = { kind: "vertex", id: sel.id, index: ei, points: np };
          setPreview({ id: sel.id, points: np });
          return;
        }
        if (tool === "select" && pointInPolygon(p, ring(sel.geometry))) {
          drag.current = { kind: "move", id: sel.id, start: p, points: pts.slice(), origin: pts.slice() };
          return;
        }
      }
      if (tool === "select") {
        const hit = pickAt(cell, p, hitR, visible, nx, ny);
        if (e.shiftKey) {
          if (hit) toggleSelect(hit.id); // Shift-click adds/removes without moving anything
          return;
        }
        select(hit?.id ?? null);
        if (hit && isContour(hit) && editable(hit)) drag.current = { kind: "move", id: hit.id, start: p, points: hit.geometry.points.slice(), origin: hit.geometry.points.slice() };
        return;
      }
      if (!activeLabel) return flash("Pick a structure first");
      if (lockedLabels.includes(activeLabel)) return flash(`${activeLabel} is locked`);
      if (!inImage(p)) return;
      if (draft.length >= 3) {
        const [fx, fy] = vs(draft[0]);
        const rect = e.currentTarget.getBoundingClientRect();
        if (Math.hypot(fx - (e.clientX - rect.left), fy - (e.clientY - rect.top)) <= CLOSE_RADIUS) return commitDraft(draft);
      }
      const last = draft.at(-1);
      if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < hitR / 4) return;
      if (!draft.length) select(null);
      setDraft((dd) => [...dd, round2(p)]);
      return;
    }
    if (tool === "freehand") {
      if (!activeLabel) return flash("Pick a structure first");
      if (lockedLabels.includes(activeLabel)) return flash(`${activeLabel} is locked`);
      select(null);
      drag.current = { kind: "freehand", path: [p] };
      return;
    }
    if (tool === "eraser") {
      const targets = cell.masks.filter((m) => visible(m) && editable(m));
      if (!targets.length) return flash("No editable mask on this slice/frame to erase");
      const layers = targets.map((m) => ({ id: m.id as string | null, label: m.label, buf: rleDecode(m.geometry.counts, nx * ny) as Uint8Array }));
      const dr: PaintDrag = { kind: "paint", erase: true, layers, last: p };
      paint(dr, p, p);
      drag.current = dr;
      setTick((t) => t + 1);
      return;
    }
    if (tool === "brush") {
      if (!activeLabel) return flash("Pick a structure first");
      const existing = cell.masks.find((m) => m.label === activeLabel);
      if (existing && !editable(existing)) return flash(`${activeLabel} is locked`);
      if (lockedLabels.includes(activeLabel)) return flash(`${activeLabel} is locked`);
      const buf = existing ? (rleDecode(existing.geometry.counts, nx * ny) as Uint8Array) : new Uint8Array(nx * ny);
      const dr: PaintDrag = { kind: "paint", erase: false, layers: [{ id: existing?.id ?? null, label: activeLabel, buf }], last: p };
      paint(dr, p, p);
      drag.current = dr;
      setTick((t) => t + 1);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const dr = drag.current;
    if (tool === "brush" || tool === "eraser") {
      const rect = e.currentTarget.getBoundingClientRect();
      setHover([e.clientX - rect.left, e.clientY - rect.top]);
    }
    if (!dr) return;
    if (dr.kind === "pan") {
      vp.movePan(e);
      return;
    }
    if (dr.kind === "wl") {
      const k = (fullWin[1] - fullWin[0]) / 600;
      const width = Math.max(1, dr.hi - dr.lo + (e.clientX - dr.x) * k);
      const center = (dr.lo + dr.hi) / 2 + (e.clientY - dr.y) * k;
      setWin([center - width / 2, center + width / 2]);
      return;
    }
    const p = voxelAt(e);
    if (dr.kind === "vertex") {
      dr.points = dragVertex(dr, p);
      setPreview({ id: dr.id, points: dr.points.slice() });
    } else if (dr.kind === "move") {
      dr.points = dragMove(dr, p);
      setPreview({ id: dr.id, points: dr.points });
    } else if (dr.kind === "freehand") {
      const last = dr.path.at(-1)!;
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.4) {
        dr.path.push(p);
        setTick((t) => t + 1);
      }
    } else if (dr.kind === "paint") {
      paint(dr, dr.last, p);
      dr.last = p;
      setTick((t) => t + 1);
    }
  };

  const onPointerUp = () => {
    const dr = drag.current;
    drag.current = null;
    if (!dr) return;
    if (dr.kind === "pan") vp.endPan();
    else if (dr.kind === "vertex" || dr.kind === "move") {
      const a = cell.contours.find((c) => c.id === dr.id);
      const before = a?.geometry.points ?? [];
      const changed = dr.points.length !== before.length || dr.points.some((q, i) => q[0] !== before[i][0] || q[1] !== before[i][1]);
      if (a && changed) editContour(a, dr.points);
      setPreview(null);
    } else if (dr.kind === "freehand") {
      if (dr.path.length >= 6 && activeLabel && polygonArea(dr.path) > 4) {
        const ctrl = toControlPoints(dr.path);
        const a = newAnnotation({ itemId: item.id, label: activeLabel, geometry: { type: "spline", points: ctrl, frame, slice }, attributes: { source: "manual" } });
        add(a);
        select(a.id);
      }
      setTick((t) => t + 1);
    } else if (dr.kind === "paint") {
      const ops: Parameters<typeof batch>[0] = { update: [], upsert: [], remove: [] };
      for (const l of dr.layers) {
        const counts = rleEncode(l.buf);
        const voxels = rleForeground(counts);
        const g = { type: "mask" as const, dims: [nx, ny], counts, voxels, volumeMm3: voxels * dx * dy * (cine?.spacing[2] ?? 1), frame, slice };
        if (l.id) {
          if (voxels === 0) ops.remove!.push(l.id);
          else ops.update!.push({ id: l.id, patch: { geometry: g } });
        } else if (voxels > 0) ops.upsert!.push(newAnnotation({ itemId: item.id, label: l.label, geometry: g, attributes: { source: "manual" } }));
      }
      batch(ops); // one undo step, even when the eraser touched several labels
      setTick((t) => t + 1);
    }
  };

  // ---- copy / interpolate / import / key frames ----
  const newAnn = (init: { label: string; geometry: Annotation["geometry"]; attributes: Annotation["attributes"] }) => newAnnotation({ itemId: item.id, ...init });
  /** Commit an edit as one undo step; a string is a message only. */
  const apply = (r: EditResult | string, after?: (r: EditResult) => void) => {
    if (typeof r === "string") return flash(r);
    if (r.upsert.length) batch({ upsert: r.upsert, remove: r.remove });
    after?.(r);
    flash(r.message);
  };

  const copyTo = (dz: number, df: number, replace = false) => {
    if (!cine) return;
    const selectedHere = [...cell.contours, ...cell.masks].filter((a) => selectedIds.includes(a.id) && visible(a));
    const r = copyCell({ cells, cell, slice, frame, nz, nt, dz, df, replace, selected: selectedHere, visible, editable, newAnn });
    apply(r, (res) => {
      if (res.goto) goto(res.goto.slice, res.goto.frame);
      if (res.upsert.length) useStudio.getState().selectMany(res.upsert.map((a) => a.id));
    });
  };

  const interpolate = (axis: "frame" | "slice") => {
    if (!cine) return;
    const picked = useStudio.getState().annotations.filter((a) => selectedIds.includes(a.id) && a.itemId === item.id && (isContour(a) || isMask(a)));
    const targets = picked.length ? [...new Set(picked.map((a) => a.label))] : activeLabel ? [activeLabel] : [];
    apply(interpolateCells({ cells, axis, slice, frame, nz, nt, cyclic: wrapCycle, targets, newAnn }));
  };

  const importRef = (scope: "slice" | "all") => {
    if (!cine) return;
    const targets = scope === "slice" ? (phaseRef ? [phaseRef] : []) : refs;
    const slices = scope === "slice" ? [slice] : Array.from({ length: nz }, (_, z) => z);
    apply(importReference({ refs: targets, slices, cells, labels, structs, nx, ny, newAnn }));
  };

  const markPhase = (phase: string, f: number) => {
    const ops = phaseOps(annotations, item.id, { [phase]: f }, (init) => newAnnotation({ itemId: item.id, label: structs.lv ?? labels[0] ?? "phase", ...init }));
    if (ops.update.length) update(ops.update[0].id, ops.update[0].patch);
    else add(ops.upsert[0]);
  };

  // ---- keyboard (keys, `when` and labels come from the manifest / environment) ----
  const stop = (fn: () => void) => () => {
    setPlaying(false);
    fn();
  };
  const copyByKey = (name: string, e: KeyboardEvent, replace: boolean) => {
    const [dz, df] = COPY_DIRS[keyIndex(e, name)] ?? COPY_DIRS[1];
    copyTo(dz, df, replace);
  };
  useCommands(
    {
      stepFrame: (e) => stop(() => stepFrame(keyIndex(e, "stepFrame") === 0 ? -1 : 1))(),
      stepSlice: (e) => stepSlice(keyIndex(e, "stepSlice") === 0 ? -1 : 1),
      // The replace variant (Shift+Alt+arrow) replaces what is already at the target.
      copyContourReplace: (e) => copyByKey("copyContourReplace", e, true),
      copyContour: (e) => copyByKey("copyContour", e, false),
      prevFrame: stop(() => stepFrame(-1)),
      nextFrame: stop(() => stepFrame(1)),
      // Hold-to-pan: a tap toggles playback on release; held while dragging, it pans.
      holdToPan: (e) => {
        if (!hold.current.code) hold.current = { code: e.code || "held", used: false };
      },
      playPause: () => setPlaying((p) => !p),
      finishShape: () => (draft.length >= 3 ? commitDraft(draft) : false),
      cancelShape: () => {
        if (!draft.length && !drag.current) return false;
        setDraft([]);
        setPreview(null);
        drag.current = null;
      },
      fitView: () => vp.fit(),
    },
    { enabled: !!cine, scope: SCOPE },
  );
  useEffect(() => {
    // Releasing the held key (whichever key holdToPan is bound to) ends the hold.
    const up = (e: KeyboardEvent) => {
      if (!hold.current.code || e.code !== hold.current.code) return;
      if (!hold.current.used) setPlaying((p) => !p);
      hold.current = { code: null, used: false };
    };
    window.addEventListener("keyup", up);
    return () => window.removeEventListener("keyup", up);
  }, []);

  const contoured = useMemo(() => {
    const s = new Set<number>();
    for (const k of cells.keys()) s.add(+k.split(":")[1]);
    return s;
  }, [cells]);
  const markers = useMemo(() => [...keyFrameOf.keys()], [keyFrameOf]);
  const refPhases = useMemo(() => [...new Set(item.assets.filter((a) => a.role === "reference" && a.phase).map((a) => a.phase!))], [item.assets]);

  if (error) return <div className="relative h-full bg-canvas"><CanvasNotice>{error}</CanvasNotice></div>;
  if (!cine || !coverage || !grid) return <div className="relative h-full bg-canvas"><CanvasNotice>Decoding 4D cine volume…</CanvasNotice></div>;

  const cursor =
    drag.current?.kind === "pan" ? "grabbing" : tool === "pan" ? "grab" : tool === "windowLevel" ? "ns-resize" : tool === "select" ? "default" : tool === "brush" || tool === "eraser" ? "none" : "crosshair";

  const hint =
    draft.length > 0
      ? `${draft.length} points · click the first point, double-click or Enter to close · Esc cancels`
      : tool === "spline" || tool === "polygon"
        ? "Click to place points. Selected contour: drag points, click its edge to add one, Alt-click to delete"
        : tool === "freehand"
          ? "Drag around the structure; it becomes an editable spline"
          : tool === "brush" || tool === "eraser"
            ? `${tool === "brush" ? `Paint the ${activeLabel ?? "active"} mask` : "Erase masks of every unlocked structure"} on this slice/frame${brushThreshold && tool === "brush" ? " (only inside the window)" : ""}`
            : null;

  // Range presets between consecutive key frames that are set (ED→ES: systole).
  const rangePresets = keyFrames.slice(0, -1).flatMap((k, i) => {
    const a = phases[k.id]?.frame, b = phases[keyFrames[i + 1].id]?.frame;
    if (a === undefined || b === undefined) return [];
    return [{ label: `${k.id}→${keyFrames[i + 1].id}`, title: `Play ${k.label.toLowerCase()} → ${keyFrames[i + 1].label.toLowerCase()} only`, range: [Math.min(a, b), Math.max(a, b)] as [number, number] }];
  });
  const phaseLabel = keyFrameOf.get(frame) ?? null;

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <CineToolbar
        keyFrames={keyFrames}
        phases={phases}
        frame={frame}
        onGotoFrame={(f) => goto(slice, f)}
        onMark={(id) => markPhase(id, frame)}
        onCopy={copyTo}
        onInterpolate={interpolate}
        wrapCycle={wrapCycle}
        onWrap={() => setWrapCycle((v) => !v)}
        hasRefs={refs.length > 0}
        refHere={!!phaseRef}
        showRef={showRef}
        onShowRef={() => setShowRef((s) => !s)}
        onImport={importRef}
        allRefsLabel={`all ${refPhases.join("/")}`.trim()}
        onAuto={() => setWin(autoWin)}
        onFull={() => setWin(fullWin)}
        invert={invert}
        onInvert={() => setInvert((v) => !v)}
        smooth={smooth}
        onSmooth={() => setSmooth((v) => !v)}
        onFit={() => vp.fit()}
        matrixOpen={matrixOpen}
        onMatrix={() => setMatrixOpen((v) => !v)}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={containerRef}
          className="relative min-h-0 flex-1 overflow-hidden bg-canvas text-canvas-foreground"
          onWheel={(e) => {
            if (e.shiftKey) stepSlice(Math.sign(e.deltaY || e.deltaX));
            else if (e.altKey) stepFrame(Math.sign(e.deltaY));
            else vp.onWheel(e, canvasRef.current!.getBoundingClientRect());
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: size.width, height: size.height, cursor }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onDoubleClick={() => draft.length >= 3 && commitDraft(draft)}
            onAuxClick={(e) => e.preventDefault()}
            data-testid="cine-canvas"
            // Read by e2e tests to map voxels to screen points and check view state.
            data-view={JSON.stringify({ frame, slice, playing, fps, mode, scale: camera.scale, tx: camera.tx, ty: camera.ty, dx, dy, win })}
          />
          {hint && <div className="pointer-events-none absolute left-3 top-3 max-w-[60%] rounded-md bg-black/60 px-2 py-1 text-xs">{hint}</div>}
          <Legend
            labels={labels}
            hidden={hiddenLabels}
            onToggle={toggleLabelHidden}
            colorOf={(l, alpha) => labelColor(labels, l, alpha)}
            header={
              <>
                <span>Slice {slice + 1}/{nz}</span>
                <span>
                  Frame {frame + 1}/{nt}
                  {phaseLabel && <span className="ml-1 font-medium text-primary">{phaseLabel}</span>}
                </span>
              </>
            }
            note={structs.myo && structs.lv ? `A ${structs.myo} contour drawn around a ${structs.lv} contour is the epicardium: myocardium = epi − LV.` : undefined}
          />
          {notice && <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-black/75 px-3 py-1.5 text-xs">{notice}</div>}
        </div>

        {matrixOpen && (
          <div className="max-h-[40%] min-h-0 shrink-0 overflow-hidden border-t border-border px-2 py-1.5">
            <SliceFrameMatrix cine={cine} slice={slice} frame={frame} onPick={goto} cells={cells} labels={labels} structs={structs} frameMetrics={coverage} marked={keyFrameOf} window={thumbWin} />
          </div>
        )}

        <Transport
          playing={playing}
          onPlay={() => setPlaying((p) => !p)}
          fps={fps}
          setFps={setFps}
          mode={mode}
          setMode={setMode}
          frame={frame}
          setFrame={(f) => {
            setPlaying(false);
            setFrame(f);
          }}
          frames={nt}
          frameLabel="Frame"
          axis={{ value: slice, set: setSlice, count: nz, label: "Slice", ariaLabel: "Slice" }}
          range={range}
          setRange={setRange}
          markers={markers}
          dotted={contoured}
          rangePresets={rangePresets}
        />
      </div>
    </div>
  );
}
