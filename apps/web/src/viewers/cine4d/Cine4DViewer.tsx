import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon as ArrowDown, ArrowLeftIcon as ArrowLeft, ArrowRightIcon as ArrowRight, ArrowUpIcon as ArrowUp, ChartIcon as BarChart3, ShowIcon as Eye, HideIcon as EyeOff, GridIcon as Grid3x3, FitIcon as Maximize, PauseIcon as Pause, PlayIcon as Play, LoopIcon as Repeat, LoopOnceIcon as Repeat1 } from "@/components/icons";
import { Slider } from "@/components/ui/slider";
import { useShortcuts } from "@/lib/hotkeys";
import { hslToRgb, labelColor, resolveLabelColor, resolveToken } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { isEditable, newAnnotation, useStudio } from "@/stores/studio";
import type { Annotation, Pt } from "@/types";
import { CanvasNotice } from "@/viewers/shared/CanvasNotice";
import { CLOSE_RADIUS, drawHandles } from "@/viewers/shared/draw";
import { distToSegment, hitVertex, pointInPolygon, polygonArea, rleDecode, rleEncode, rleForeground } from "@/viewers/shared/geometry";
import { useCanvasSize } from "@/viewers/shared/useCanvasSize";
import { useViewport2D } from "@/viewers/shared/useViewport2D";
import type { ViewerProps } from "@/viewers/ViewerAdapter";
import { loadVolume, type Volume } from "@/viewers/volume3d/nifti";
import { MetricsPanel } from "./MetricsPanel";
import { PhaseMatrix } from "./PhaseMatrix";
import {
  cellKey,
  computeMetrics,
  diceVsReference,
  groupCells,
  interpolateContour,
  isContour,
  isMask,
  isPhase,
  knownGrids,
  labelValue,
  maskToControlPoints,
  mosteller,
  referenceSlices,
  resolvePhases,
  ring,
  structures,
  toControlPoints,
  type Cell,
  type ContourAnn,
  type ContourGeometry,
  type Grid,
  type MaskAnn,
  type StructKey,
} from "./model";
import { fetchBodySize } from "./niftiIO";
import { fullRange, percentileWindow, renderLabelMap, renderSlice, useCinePlayback, type PlayMode, type Rgb } from "./render";

type Drag =
  | { kind: "pan" }
  | { kind: "wl"; x: number; y: number; lo: number; hi: number }
  | { kind: "vertex"; id: string; index: number; points: Pt[] }
  | { kind: "move"; id: string; start: Pt; points: Pt[]; origin: Pt[] }
  | { kind: "freehand"; path: Pt[] }
  /** Brush paints one layer (the active label); the eraser clears every editable mask on the slice/frame. */
  | { kind: "paint"; erase: boolean; layers: { id: string | null; label: string; buf: Uint8Array }[]; last: Pt };

interface RefSeg {
  frame: number;
  phase: string;
  volume: Volume;
}

const EMPTY_CELL: Cell = { contours: [], masks: [] };
const round2 = (p: Pt): Pt => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
/** Dense samples per control-point segment, matching model.ring(). */
const SAMPLES = 12;

export function Cine4DViewer({ project, item }: ViewerProps) {
  const cineAsset = item.assets.find((a) => a.role === "cine");
  const labels = useMemo(() => project.labels ?? [], [project.labels]);
  const structs = useMemo(() => structures(labels), [labels]);

  // ---- data ----
  const [cine, setCine] = useState<Volume | null>(null);
  const [refs, setRefs] = useState<RefSeg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState<{ height: number | null; weight: number | null }>({ height: null, weight: null });

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
        const ed = item.assets.find((a) => a.role === "reference" && a.phase === "ED")?.frame;
        setFrame(ed ?? 0);
      })
      .catch((e: Error) => live && setError(e.message));
    Promise.all(
      item.assets.filter((a) => a.role === "reference").map(async (a) => ({ frame: a.frame ?? 0, phase: a.phase ?? "", volume: await loadVolume(a.path) })),
    )
      .then((r) => live && setRefs(r))
      .catch(() => live && setRefs([]));
    fetchBodySize(cineAsset.path, project.meta).then((b) => live && setBody(b));
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
  const [range, setRange] = useState<[number | null, number | null]>([null, null]);
  const [win, setWin] = useState<[number, number]>([0, 1]);
  const [invert, setInvert] = useState(false);
  const [smooth, setSmooth] = useState(true);
  const [showRef, setShowRef] = useState(true);
  // The matrix would squeeze the image on short screens; start it collapsed there.
  const [matrixOpen, setMatrixOpen] = useState(() => window.innerHeight >= 900);
  const [metricsOpen, setMetricsOpen] = useState(true);
  const [wrapCycle, setWrapCycle] = useState(false);
  const [draft, setDraft] = useState<Pt[]>([]);
  const [preview, setPreview] = useState<{ id: string; points: Pt[] } | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const drag = useRef<Drag | null>(null);
  const space = useRef({ down: false, used: false });

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
  const toolOptions = useStudio((s) => s.toolOptions);
  const { add, update, select, toggleSelect, batch, setViewerStatus, toggleLabelHidden } = useStudio.getState();

  const grid = useMemo<Grid | null>(
    () => (cine ? { nx: cine.dims[0], ny: cine.dims[1], nz: cine.dims[2], frames: cine.frames, spacing: cine.spacing } : null),
    [cine],
  );
  useEffect(() => {
    if (grid) knownGrids.set(item.id, grid);
  }, [grid, item.id]);

  const nx = cine?.dims[0] ?? 0, ny = cine?.dims[1] ?? 0, nz = cine?.dims[2] ?? 1, nt = cine?.frames ?? 1;
  const dx = cine?.spacing[0] ?? 1, dy = cine?.spacing[1] ?? 1;

  const cells = useMemo(() => groupCells(annotations, item.id), [annotations, item.id]);
  const cell = cells.get(cellKey(slice, frame)) ?? EMPTY_CELL;
  const phases = useMemo(() => resolvePhases(annotations, item.id, item.assets, project.meta), [annotations, item.id, item.assets, project.meta]);
  const ed = phases.ed?.frame ?? null, es = phases.es?.frame ?? null;
  const bsa = mosteller(body.height, body.weight);
  const refSlices = useMemo(() => (grid ? new Map(refs.map((r) => [r.frame, referenceSlices(r.volume, labels, grid)])) : undefined), [refs, labels, grid]);
  const metrics = useMemo(
    () => (grid ? computeMetrics({ annotations, itemId: item.id, labels, grid, ed, es, bsa, refSlices }) : null),
    [annotations, item.id, labels, grid, ed, es, bsa, refSlices],
  );
  const qa = useMemo(
    () => (grid ? refs.map((r) => ({ phase: r.phase, frame: r.frame, rows: diceVsReference(cells, r.frame, r.volume.data, labels, grid) })) : []),
    [refs, cells, labels, grid],
  );
  const phaseRef = refs.find((r) => r.frame === frame);

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
  const rangeFrom = range[0] !== null && range[1] !== null ? Math.min(range[0], range[1]) : 0;
  const rangeTo = range[0] !== null && range[1] !== null ? Math.max(range[0], range[1]) : nt - 1;
  useCinePlayback({ playing, fps, mode, from: rangeFrom, to: rangeTo, setFrame });

  // ---- navigation ----
  const stepFrame = useCallback((d: number) => setFrame((f) => (f + d + nt) % nt), [nt]);
  const stepSlice = useCallback((d: number) => setSlice((s) => Math.max(0, Math.min(nz - 1, s + d))), [nz]);
  const goto = useCallback((z: number, f: number) => {
    setPlaying(false);
    setSlice(z);
    setFrame(f);
  }, []);

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
    const phase = frame === ed ? " (ED)" : frame === es ? " (ES)" : "";
    const w = win[1] - win[0], l = (win[0] + win[1]) / 2;
    setViewerStatus(
      `Slice ${slice + 1}/${nz} · Frame ${frame + 1}/${nt}${phase} · W ${w.toFixed(0)} L ${l.toFixed(0)} · ${Math.round(camera.scale * dx * 100)}% · ${dx.toFixed(2)}×${dy.toFixed(2)}×${cine.spacing[2].toFixed(1)} mm`,
    );
  }, [cine, slice, frame, ed, es, win, camera.scale, dx, dy, nz, nt, setViewerStatus]);

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
    return (maskCanvas.current = renderLabelMap(map, 0, nx, ny, colorsByValue, 0.45 * overlayOpacity, toolOptions.outlineOnly, maskCanvas.current));
    // `tick` re-renders the live brush stroke held in the drag ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cine, cell.masks, visible, paintKey, tick, nx, ny, labels, colorsByValue, overlayOpacity, toolOptions.outlineOnly]);

  // ---- draw ----
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !size.width || !cine || !base) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    const [x0, y0] = toScreen(0, 0);
    const w = nx * dx * camera.scale, h = ny * dy * camera.scale;
    ctx.imageSmoothingEnabled = smooth;
    ctx.drawImage(base, x0, y0, w, h);
    ctx.imageSmoothingEnabled = false;
    if (refLayer) {
      ctx.globalAlpha = 0.55 * overlayOpacity + 0.2;
      ctx.drawImage(refLayer, x0, y0, w, h);
      ctx.globalAlpha = 1;
    }
    if (maskLayer) ctx.drawImage(maskLayer, x0, y0, w, h);

    const contours = cell.contours.filter(visible);
    const lvs = contours.filter((c) => c.label === structs.lv);
    const aiColor = resolveToken("--prov-ai");
    for (const a of contours) {
      const pts = preview?.id === a.id ? preview.points : a.geometry.points;
      const g: ContourGeometry = { ...a.geometry, points: pts } as ContourGeometry;
      const outer = (preview?.id === a.id ? ring(g) : ring(a.geometry)).map(vs);
      if (outer.length < 3) continue;
      const isSel = selectedIds.includes(a.id);
      const isPrimary = a.id === selectedId;
      // Myocardium drawn around an LV contour is the epicardium: fill the ring only.
      const holes = a.label === structs.myo ? lvs.filter((lv) => pointInPolygon(centroid(ring(lv.geometry)), ring(g))).map((lv) => ring(lv.geometry).map(vs)) : [];
      ctx.save();
      ctx.beginPath();
      for (const r of [outer, ...holes]) {
        ctx.moveTo(r[0][0], r[0][1]);
        for (let i = 1; i < r.length; i++) ctx.lineTo(r[i][0], r[i][1]);
        ctx.closePath();
      }
      if (!toolOptions.outlineOnly) {
        ctx.fillStyle = resolveLabelColor(labels, a.label, (isSel ? 0.3 : 0.18) * overlayOpacity);
        ctx.fill("evenodd");
      }
      ctx.beginPath();
      ctx.moveTo(outer[0][0], outer[0][1]);
      for (let i = 1; i < outer.length; i++) ctx.lineTo(outer[i][0], outer[i][1]);
      ctx.closePath();
      const ai = a.provenance === "ai-suggested";
      const src = a.attributes?.source;
      ctx.strokeStyle = ai ? aiColor : resolveLabelColor(labels, a.label);
      ctx.lineWidth = isSel ? 2.5 : 1.5;
      ctx.setLineDash(ai ? [6, 4] : src === "interpolated" ? [5, 3] : src === "copied" ? [2, 3] : []);
      ctx.stroke();
      ctx.restore();
      if (isPrimary && editable(a)) drawHandles(ctx, pts.map(vs), drag.current?.kind === "vertex" ? drag.current.index : -1, 7);
    }

    // Draft (spline/polygon in progress) and freehand path.
    const dr = drag.current;
    const drawOpen = (pts: Pt[], closed: boolean) => {
      if (!pts.length || !activeLabel) return;
      const sp = pts.map(vs);
      ctx.save();
      ctx.strokeStyle = resolveLabelColor(labels, activeLabel);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(sp[0][0], sp[0][1]);
      for (const [x, y] of sp.slice(1)) ctx.lineTo(x, y);
      if (closed) ctx.closePath();
      ctx.stroke();
      ctx.restore();
    };
    if (draft.length) {
      const smoothDraft = tool === "spline" && draft.length >= 3 ? ring({ type: "spline", points: draft }) : draft;
      drawOpen(smoothDraft, tool === "spline" && draft.length >= 3);
      ctx.save();
      for (const [i, [x, y]] of draft.map(vs).entries()) {
        ctx.fillStyle = i === 0 ? resolveToken("--primary") : "#fff";
        ctx.beginPath();
        ctx.arc(x, y, i === 0 ? 4.5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (dr?.kind === "freehand") drawOpen(dr.path, false);

    // Brush cursor.
    if (hover && (tool === "brush" || tool === "eraser")) {
      ctx.save();
      ctx.strokeStyle = tool === "eraser" ? "rgba(255,255,255,0.8)" : activeLabel ? resolveLabelColor(labels, activeLabel) : "#fff";
      ctx.setLineDash(tool === "eraser" ? [3, 3] : []);
      ctx.beginPath();
      ctx.arc(hover[0], hover[1], toolOptions.brushSize / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
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

  /** Control-point index to insert at when clicking near the contour outline, or -1. */
  const edgeInsertIndex = (g: ContourGeometry, p: Pt): number => {
    if (g.type === "polygon") {
      let best = -1, bestD = hitR;
      for (let i = 0; i < g.points.length; i++) {
        const { d } = distToSegment(p, g.points[i], g.points[(i + 1) % g.points.length]);
        if (d <= bestD) {
          bestD = d;
          best = i + 1;
        }
      }
      return best;
    }
    const dense = ring(g);
    let best = -1, bestD = hitR;
    for (let i = 0; i < dense.length; i++) {
      const { d } = distToSegment(p, dense[i], dense[(i + 1) % dense.length]);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best < 0 ? -1 : Math.floor(best / SAMPLES) + 1;
  };

  /** Topmost annotation under p: the smallest contour containing it (or whose edge is near), else a mask. */
  const pickAt = (p: Pt): Annotation | null => {
    let best: ContourAnn | null = null, bestA = Infinity;
    for (const c of cell.contours.filter(visible)) {
      const r = ring(c.geometry);
      if (r.length < 3) continue;
      const near = r.some((q, i) => distToSegment(p, q, r[(i + 1) % r.length]).d <= hitR);
      if (!near && !pointInPolygon(p, r)) continue;
      const area = polygonArea(r);
      if (area < bestA) {
        bestA = area;
        best = c;
      }
    }
    if (best) return best;
    const i = Math.floor(p[0]), j = Math.floor(p[1]);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return null;
    for (const m of [...cell.masks].reverse().filter(visible)) {
      const buf = rleDecode(m.geometry.counts, nx * ny);
      if (buf[j * nx + i]) return m;
    }
    return null;
  };

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

  const stamp = (dr: Extract<Drag, { kind: "paint" }>, a: Pt, b: Pt) => {
    if (!cine) return;
    const r = toolOptions.brushSize / 2 / (camera.scale * Math.min(dx, dy));
    const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(dist / Math.max(0.5, r / 2)));
    const baseOff = frame * nx * ny * nz + slice * nx * ny;
    for (let s = 0; s <= steps; s++) {
      const cx = a[0] + ((b[0] - a[0]) * s) / steps, cy = a[1] + ((b[1] - a[1]) * s) / steps;
      for (let j = Math.max(0, Math.floor(cy - r)); j <= Math.min(ny - 1, Math.ceil(cy + r)); j++) {
        for (let i = Math.max(0, Math.floor(cx - r)); i <= Math.min(nx - 1, Math.ceil(cx + r)); i++) {
          if ((i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 > r * r) continue;
          const p = j * nx + i;
          if (dr.erase) for (const l of dr.layers) l.buf[p] = 0;
          else {
            if (toolOptions.brushThreshold) {
              const v = cine.data[baseOff + p];
              if (v < win[0] || v > win[1]) continue;
            }
            dr.layers[0].buf[p] = 1;
          }
        }
      }
    }
  };

  // ---- pointer ----
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!cine) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.button === 1 || space.current.down || tool === "pan") {
      if (space.current.down) space.current.used = true;
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
        const ei = edgeInsertIndex(sel.geometry, p);
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
        const hit = pickAt(p);
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
      const dr: Drag = { kind: "paint", erase: true, layers, last: p };
      stamp(dr, p, p);
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
      const dr: Drag = { kind: "paint", erase: false, layers: [{ id: existing?.id ?? null, label: activeLabel, buf }], last: p };
      stamp(dr, p, p);
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
      dr.points[dr.index] = round2(p);
      setPreview({ id: dr.id, points: dr.points.slice() });
    } else if (dr.kind === "move") {
      const ddx = p[0] - dr.start[0], ddy = p[1] - dr.start[1];
      dr.points = dr.origin.map(([x, y]) => round2([x + ddx, y + ddy]));
      setPreview({ id: dr.id, points: dr.points });
    } else if (dr.kind === "freehand") {
      const last = dr.path.at(-1)!;
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.4) {
        dr.path.push(p);
        setTick((t) => t + 1);
      }
    } else if (dr.kind === "paint") {
      stamp(dr, dr.last, p);
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

  // ---- copy / interpolate / import ----
  /** Annotations of the current slice/frame that are selected (several with Shift-click). */
  const selectedHere = (): (ContourAnn | MaskAnn)[] =>
    [...cell.contours, ...cell.masks].filter((a) => selectedIds.includes(a.id) && visible(a));

  const copyTo = (dz: number, df: number, replace = false) => {
    if (!cine) return;
    const tz = slice + dz;
    if (tz < 0 || tz >= nz) return flash("No slice in that direction");
    const tf = (frame + df + nt) % nt;
    const picked = selectedHere();
    const sources: (ContourAnn | MaskAnn)[] = picked.length ? picked : [...cell.contours, ...cell.masks].filter(visible);
    if (!sources.length) return flash("Nothing to copy on this slice/frame");
    const target = cells.get(cellKey(tz, tf)) ?? EMPTY_CELL;
    const created: Annotation[] = [];
    const skipped: string[] = [];
    const removed: string[] = [];
    for (const s of sources) {
      const clashes: Annotation[] = isContour(s) ? target.contours.filter((c) => c.label === s.label) : target.masks.filter((m) => m.label === s.label);
      if (clashes.length) {
        // Replace only what may be edited; locked targets are kept and the copy skipped.
        if (!replace || clashes.some((c) => !editable(c))) {
          skipped.push(s.label);
          continue;
        }
        removed.push(...clashes.map((c) => c.id));
      }
      created.push(
        newAnnotation({
          itemId: item.id,
          label: s.label,
          geometry: { ...s.geometry, slice: tz, frame: tf } as Annotation["geometry"],
          attributes: { ...s.attributes, source: "copied" },
        }),
      );
    }
    if (created.length) batch({ upsert: created, remove: removed });
    goto(tz, tf);
    if (created.length) useStudio.getState().selectMany(created.map((a) => a.id));
    const where = dz ? `slice ${tz + 1}` : `frame ${tf + 1}`;
    flash(
      `${created.length ? `${removed.length ? "Replaced" : "Copied"} ${created.length} to ${where}` : `Nothing copied to ${where}`}${
        skipped.length ? ` · already there: ${[...new Set(skipped)].join(", ")} (Shift+Alt+arrow replaces)` : ""
      }`,
    );
  };

  const interpolate = (axis: "frame" | "slice") => {
    if (!cine) return;
    const picked = useStudio.getState().annotations.filter((a) => selectedIds.includes(a.id) && a.itemId === item.id && (isContour(a) || isMask(a)));
    const targets = picked.length ? [...new Set(picked.map((a) => a.label))] : activeLabel ? [activeLabel] : [];
    if (!targets.length) return flash("Pick a structure first");
    const n = axis === "frame" ? nt : nz;
    const cyclic = axis === "frame" && wrapCycle;
    const at = (k: number) => cells.get(axis === "frame" ? cellKey(slice, k) : cellKey(k, frame)) ?? EMPTY_CELL;
    const created: Annotation[] = [];
    const tooFew: string[] = [];
    for (const label of targets) {
      const keys: { k: number; g: ContourGeometry }[] = [];
      for (let k = 0; k < n; k++) {
        const cs = at(k).contours.filter((c) => c.label === label && c.attributes?.source !== "interpolated");
        if (cs.length === 1) keys.push({ k, g: cs[0].geometry });
      }
      if (keys.length < 2) {
        tooFew.push(label);
        continue;
      }
      const pairs: [typeof keys[number], typeof keys[number], number][] = [];
      for (let i = 0; i + 1 < keys.length; i++) pairs.push([keys[i], keys[i + 1], keys[i + 1].k]);
      // The cardiac cycle is periodic: the last key frame also leads back to the first.
      if (cyclic) pairs.push([keys[keys.length - 1], keys[0], keys[0].k + n]);
      for (const [a, b, bk] of pairs) {
        for (let kk = a.k + 1; kk < bk; kk++) {
          const k = kk % n;
          const c = at(k);
          if (c.contours.some((x) => x.label === label) || c.masks.some((x) => x.label === label)) continue;
          const points = interpolateContour(a.g, b.g, (kk - a.k) / (bk - a.k));
          created.push(
            newAnnotation({
              itemId: item.id,
              label,
              geometry: { type: "spline", points, slice: axis === "frame" ? slice : k, frame: axis === "frame" ? k : frame },
              attributes: { source: "interpolated" },
            }),
          );
        }
      }
    }
    const where = axis === "frame" ? "of this slice" : "of this frame";
    if (!created.length)
      return flash(tooFew.length ? `Draw ${tooFew.join(", ")} on at least two ${axis}s ${where} first` : `No empty ${axis}s between key contours`);
    batch({ upsert: created });
    flash(
      `Interpolated ${created.length} contour${created.length > 1 ? "s" : ""} (${targets.filter((t) => !tooFew.includes(t)).join(", ")}) across ${axis}s${cyclic ? ", wrapping the cycle" : ""}${
        tooFew.length ? ` · need two keys: ${tooFew.join(", ")}` : ""
      }`,
    );
  };

  const importReference = (scope: "slice" | "all") => {
    if (!cine) return;
    const targets = scope === "slice" ? (phaseRef ? [phaseRef] : []) : refs;
    if (!targets.length) return flash("No reference segmentation on this frame");
    const n = nx * ny;
    const created: Annotation[] = [];
    for (const r of targets) {
      const zs = scope === "slice" ? [slice] : Array.from({ length: nz }, (_, z) => z);
      for (const z of zs) {
        const c = cells.get(cellKey(z, r.frame)) ?? EMPTY_CELL;
        const vals: Partial<Record<StructKey, number>> = {};
        for (const k of ["rv", "myo", "lv"] as StructKey[]) if (structs[k]) vals[k] = labelValue(labels, structs[k]!);
        const src = r.volume.data;
        for (const k of ["rv", "myo", "lv"] as StructKey[]) {
          const name = structs[k];
          if (!name || c.contours.some((x) => x.label === name) || c.masks.some((x) => x.label === name)) continue;
          const mask = new Uint8Array(n);
          let any = 0;
          for (let i = 0; i < n; i++) {
            const v = src[z * n + i];
            if (v === vals[k]) any++;
            // Myocardium becomes its epicardium: the ring plus the LV cavity it surrounds.
            mask[i] = v === vals[k] || (k === "myo" && v === vals.lv) ? 1 : 0;
          }
          if (!any) continue;
          const points = maskToControlPoints(mask, nx, ny);
          if (!points) continue;
          created.push(newAnnotation({ itemId: item.id, label: name, geometry: { type: "spline", points, slice: z, frame: r.frame }, attributes: { source: "reference" } }));
        }
      }
    }
    if (!created.length) return flash("Reference already imported (or this slice has no reference structures)");
    batch({ upsert: created });
    flash(`Imported ${created.length} reference contour${created.length > 1 ? "s" : ""} as editable splines`);
  };

  const markPhase = (phase: "ED" | "ES", f: number) => {
    const existing = annotations.find((a) => a.itemId === item.id && isPhase(a) && a.geometry.phase === phase);
    const geometry = { type: "phase" as const, phase, frame: f };
    if (existing) update(existing.id, { geometry });
    else add(newAnnotation({ itemId: item.id, label: structs.lv ?? labels[0] ?? "phase", geometry }));
  };
  const applySuggestion = () => {
    const s = metrics?.suggested;
    if (!s) return;
    const ops: Parameters<typeof batch>[0] = { update: [], upsert: [] };
    for (const p of ["ED", "ES"] as const) {
      const geometry = { type: "phase" as const, phase: p, frame: p === "ED" ? s.ed : s.es };
      const existing = annotations.find((a) => a.itemId === item.id && isPhase(a) && a.geometry.phase === p);
      if (existing) ops.update!.push({ id: existing.id, patch: { geometry } });
      else ops.upsert!.push(newAnnotation({ itemId: item.id, label: structs.lv ?? labels[0] ?? "phase", geometry }));
    }
    batch(ops); // ED and ES change together as one undo step
  };

  // ---- keyboard ----
  const stop = (fn: () => void) => () => {
    setPlaying(false);
    fn();
  };
  useShortcuts(
    {
      stepFrame: (e) => stop(() => stepFrame(e.key === "ArrowLeft" ? -1 : 1))(),
      stepSlice: (e) => stepSlice(e.key === "ArrowUp" ? -1 : 1),
      // Shift+Alt+arrow replaces what is already at the target.
      copyContour: (e) =>
        e.key === "ArrowLeft" || e.key === "ArrowRight" ? copyTo(0, e.key === "ArrowLeft" ? -1 : 1, e.shiftKey) : copyTo(e.key === "ArrowUp" ? -1 : 1, 0, e.shiftKey),
      copyContourReplace: (e) =>
        e.key === "ArrowLeft" || e.key === "ArrowRight" ? copyTo(0, e.key === "ArrowLeft" ? -1 : 1, true) : copyTo(e.key === "ArrowUp" ? -1 : 1, 0, true),
      prevFrame: stop(() => stepFrame(-1)),
      nextFrame: stop(() => stepFrame(1)),
      // Space: tap toggles play; held while dragging pans (see keyup below).
      playPause: () => {
        if (!space.current.down) space.current = { down: true, used: false };
      },
      finishShape: () => (draft.length >= 3 ? commitDraft(draft) : false),
      cancelShape: () => {
        if (!draft.length && !drag.current) return false;
        setDraft([]);
        setPreview(null);
        drag.current = null;
      },
      fitViewCine: () => vp.fit(),
    },
    { enabled: !!cine },
  );
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !space.current.down) return;
      if (!space.current.used) setPlaying((p) => !p);
      space.current = { down: false, used: false };
    };
    window.addEventListener("keyup", up);
    return () => window.removeEventListener("keyup", up);
  }, []);

  if (error) return <div className="relative h-full bg-canvas"><CanvasNotice>{error}</CanvasNotice></div>;
  if (!cine || !metrics || !grid) return <div className="relative h-full bg-canvas"><CanvasNotice>Decoding 4D cine volume…</CanvasNotice></div>;

  const cursor =
    drag.current?.kind === "pan" ? "grabbing" : tool === "pan" ? "grab" : tool === "windowLevel" ? "ns-resize" : tool === "select" ? "default" : tool === "brush" || tool === "eraser" ? "none" : "crosshair";
  const contoured = new Set<number>();
  for (const k of cells.keys()) contoured.add(+k.split(":")[1]);

  const hint =
    draft.length > 0
      ? `${draft.length} points · click the first point, double-click or Enter to close · Esc cancels`
      : tool === "spline" || tool === "polygon"
        ? "Click to place points. Selected contour: drag points, click its edge to add one, Alt-click to delete"
        : tool === "freehand"
          ? "Drag around the structure; it becomes an editable spline"
          : tool === "brush" || tool === "eraser"
            ? `${tool === "brush" ? `Paint the ${activeLabel ?? "active"} mask` : "Erase masks of every unlocked structure"} on this slice/frame${toolOptions.brushThreshold && tool === "brush" ? " (only inside the window)" : ""}`
            : null;

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Phase, propagation and display controls */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b border-border px-2 py-1.5 text-xs">
        {(["ED", "ES"] as const).map((p) => {
          const m = p === "ED" ? phases.ed : phases.es;
          return (
            <TB
              key={p}
              active={m !== null && frame === m.frame}
              onClick={() => m && goto(slice, m.frame)}
              disabled={!m}
              title={`${p === "ED" ? "End-diastole" : "End-systole"}${m ? ` · frame ${m.frame + 1} (${m.source === "marked" ? "marked" : m.source === "reference" ? "from reference" : "from metadata"})` : " · not set"}`}
            >
              {p} {m ? m.frame + 1 : "—"}
              {m && m.source !== "marked" && <span className="text-hint">*</span>}
            </TB>
          );
        })}
        <TB onClick={() => markPhase("ED", frame)} title="Mark the current frame as end-diastole">Set ED</TB>
        <TB onClick={() => markPhase("ES", frame)} title="Mark the current frame as end-systole">Set ES</TB>
        <Sep />
        <span className="text-muted-foreground">Copy</span>
        <TB onClick={(e) => copyTo(0, -1, e.shiftKey)} title="Copy selected (or all) contours to the previous frame (Alt+←). Shift replaces what is there"><ArrowLeft className="h-3.5 w-3.5" /></TB>
        <TB onClick={(e) => copyTo(0, 1, e.shiftKey)} title="Copy to the next frame (Alt+→)"><ArrowRight className="h-3.5 w-3.5" /></TB>
        <TB onClick={(e) => copyTo(-1, 0, e.shiftKey)} title="Copy to the previous slice (Alt+↑)"><ArrowUp className="h-3.5 w-3.5" /></TB>
        <TB onClick={(e) => copyTo(1, 0, e.shiftKey)} title="Copy to the next slice (Alt+↓)"><ArrowDown className="h-3.5 w-3.5" /></TB>
        <span className="ml-1 text-muted-foreground">Interpolate</span>
        <TB onClick={() => interpolate("frame")} title="Fill empty frames of this slice between key contours of the selected/active structure">frames</TB>
        <TB onClick={() => interpolate("slice")} title="Fill empty slices of this frame between key contours of the selected/active structure">slices</TB>
        <TB onClick={() => setWrapCycle((v) => !v)} active={wrapCycle} title="Frame interpolation wraps around the cardiac cycle (last key frame → first)">wrap</TB>
        <Sep />
        <span className="text-muted-foreground">Reference</span>
        <TB onClick={() => setShowRef((s) => !s)} disabled={!refs.length} active={showRef && !!phaseRef} title="Show the reference segmentation outline on ED/ES frames">
          {showRef ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </TB>
        <TB onClick={() => importReference("slice")} disabled={!phaseRef} title="Convert the reference on this slice into editable spline contours">→ contours</TB>
        <TB onClick={() => importReference("all")} disabled={!refs.length} title="Convert the reference on every slice of every reference frame (ED and ES)">all ED/ES</TB>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-muted-foreground">W/L</span>
          <TB onClick={() => setWin(autoWin)} title="Auto window: 1st–99th percentile">Auto</TB>
          <TB onClick={() => setWin(fullWin)} title="Full intensity range">Full</TB>
          <TB onClick={() => setInvert((v) => !v)} active={invert} title="Invert grey scale">Inv</TB>
          <TB onClick={() => setSmooth((v) => !v)} active={smooth} title="Bilinear interpolation (off = nearest neighbour pixels)">Smooth</TB>
          <TB onClick={() => vp.fit()} title="Fit to view (=)"><Maximize className="h-3.5 w-3.5" /></TB>
          <Sep />
          <TB onClick={() => setMatrixOpen((v) => !v)} active={matrixOpen} title="Slice × phase matrix"><Grid3x3 className="h-3.5 w-3.5" /></TB>
          <TB onClick={() => setMetricsOpen((v) => !v)} active={metricsOpen} title="Volumes and function"><BarChart3 className="h-3.5 w-3.5" /></TB>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
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
            <Legend labels={labels} structs={structs} hidden={hiddenLabels} onToggle={toggleLabelHidden} phaseLabel={frame === ed ? "ED" : frame === es ? "ES" : null} slice={slice} nz={nz} frame={frame} nt={nt} />
            {notice && (
              <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-black/75 px-3 py-1.5 text-xs">{notice}</div>
            )}
          </div>

          {matrixOpen && (
            <div className="max-h-[40%] min-h-0 shrink-0 overflow-hidden border-t border-border px-2 py-1.5">
              <PhaseMatrix
                cine={cine}
                slice={slice}
                frame={frame}
                onPick={goto}
                cells={cells}
                labels={labels}
                structs={structs}
                frameMetrics={metrics.frames}
                ed={ed}
                es={es}
                window={thumbWin}
              />
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
            nt={nt}
            slice={slice}
            setSlice={setSlice}
            nz={nz}
            range={range}
            setRange={setRange}
            ed={ed}
            es={es}
            contoured={contoured}
          />
        </div>

        {metricsOpen && (
          <aside className="w-72 shrink-0 overflow-y-auto border-l border-border">
            <MetricsPanel
              metrics={metrics}
              labels={labels}
              structs={structs}
              frame={frame}
              slice={slice}
              onFrame={(f) => goto(slice, f)}
              phases={phases}
              onApplySuggestion={applySuggestion}
              height={body.height}
              weight={body.weight}
              onBody={setBody}
              qa={qa}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

function centroid(pts: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

function TB({ children, active, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...rest}
      className={cn(
        "flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors disabled:opacity-35",
        active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-generic",
        className,
      )}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-1 h-4 w-px bg-border" />;

function Legend({
  labels,
  structs,
  hidden,
  onToggle,
  phaseLabel,
  slice,
  nz,
  frame,
  nt,
}: {
  labels: string[];
  structs: Record<StructKey, string | undefined>;
  hidden: string[];
  onToggle: (l: string) => void;
  phaseLabel: string | null;
  slice: number;
  nz: number;
  frame: number;
  nt: number;
}) {
  return (
    <div className="absolute right-3 top-3 w-52 rounded-md bg-black/60 px-2 py-1.5 text-xs">
      <div className="mb-1 flex justify-between tnum text-canvas-foreground/70">
        <span>Slice {slice + 1}/{nz}</span>
        <span>
          Frame {frame + 1}/{nt}
          {phaseLabel && <span className="ml-1 font-medium text-primary">{phaseLabel}</span>}
        </span>
      </div>
      {labels.map((l) => (
        <button key={l} onClick={() => onToggle(l)} className="flex w-full items-center gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-white/10" title={hidden.includes(l) ? "Show" : "Hide"}>
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: labelColor(labels, l, hidden.includes(l) ? 0.3 : 1) }} />
          <span className={cn("flex-1 capitalize", hidden.includes(l) && "text-canvas-foreground/40 line-through")}>{l}</span>
          {hidden.includes(l) ? <EyeOff className="h-3 w-3 opacity-60" /> : <Eye className="h-3 w-3 opacity-60" />}
        </button>
      ))}
      {structs.myo && structs.lv && (
        <p className="mt-1 border-t border-white/10 pt-1 text-[10px] leading-snug text-canvas-foreground/55">
          A {structs.myo} contour drawn around a {structs.lv} contour is the epicardium: myocardium = epi − LV.
        </p>
      )}
    </div>
  );
}

function Transport(props: {
  playing: boolean;
  onPlay: () => void;
  fps: number;
  setFps: (n: number) => void;
  mode: PlayMode;
  setMode: (m: PlayMode) => void;
  frame: number;
  setFrame: (f: number) => void;
  nt: number;
  slice: number;
  setSlice: (s: number) => void;
  nz: number;
  range: [number | null, number | null];
  setRange: (r: [number | null, number | null]) => void;
  ed: number | null;
  es: number | null;
  contoured: Set<number>;
}) {
  const { playing, onPlay, fps, setFps, mode, setMode, frame, setFrame, nt, slice, setSlice, nz, range, setRange, ed, es, contoured } = props;
  const pct = (f: number) => `${(f / Math.max(1, nt - 1)) * 100}%`;
  const [a, b] = range;
  const lo = a !== null && b !== null ? Math.min(a, b) : null, hi = a !== null && b !== null ? Math.max(a, b) : null;
  return (
    <div className="space-y-2 border-t border-border px-3 py-2 text-xs">
      <div className="flex items-center gap-3">
        <button
          onClick={onPlay}
          aria-label={playing ? "Pause" : "Play"}
          title="Play / pause (Space)"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary-hover"
        >
          {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <span className="w-10 shrink-0 text-muted-foreground">Time</span>
        <div className="relative flex-1">
          {lo !== null && hi !== null && (
            <div className="pointer-events-none absolute -top-1 h-1 rounded-full bg-primary/40" style={{ left: pct(lo), width: `calc(${pct(hi)} - ${pct(lo)})` }} />
          )}
          <Slider value={[frame]} min={0} max={nt - 1} step={1} onValueChange={([f]) => setFrame(f)} aria-label="Cardiac phase (frame)" />
          <div className="pointer-events-none absolute -bottom-1.5 left-0 right-0 h-1">
            {Array.from({ length: nt }, (_, f) => (
              <span
                key={f}
                className={cn("absolute h-1 w-1 -translate-x-1/2 rounded-full", f === ed || f === es ? "h-1.5 w-1.5 bg-primary" : contoured.has(f) ? "bg-muted-foreground" : "")}
                style={{ left: pct(f) }}
              />
            ))}
          </div>
        </div>
        <span className="tnum w-14 shrink-0 text-right text-foreground/80">
          {frame + 1}/{nt}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-7 shrink-0" />
        <span className="w-10 shrink-0 text-muted-foreground">Slice</span>
        <Slider value={[slice]} min={0} max={nz - 1} step={1} onValueChange={([s]) => setSlice(s)} aria-label="Short-axis slice" className="flex-1" />
        <span className="tnum w-14 shrink-0 text-right text-foreground/80">
          {slice + 1}/{nz}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-foreground/80">
        <span className="w-7 shrink-0" />
        <span className="w-10 shrink-0 text-muted-foreground">Cine</span>
        <Slider value={[fps]} min={1} max={60} step={1} onValueChange={([v]) => setFps(v)} aria-label="Frames per second" className="w-24" />
        <span className="tnum w-12">{fps} fps</span>
        <TB onClick={() => setMode(mode === "loop" ? "bounce" : "loop")} title="Loop restarts at the first frame; bounce plays back and forth">
          {mode === "loop" ? <Repeat className="h-3.5 w-3.5" /> : <Repeat1 className="h-3.5 w-3.5" />}
          {mode === "loop" ? "Loop" : "Bounce"}
        </TB>
        <Sep />
        <TB onClick={() => setRange([frame, b])} active={a !== null} title="Set the start of the play range to this frame">A{a !== null ? ` ${a + 1}` : ""}</TB>
        <TB onClick={() => setRange([a, frame])} active={b !== null} title="Set the end of the play range to this frame">B{b !== null ? ` ${b + 1}` : ""}</TB>
        {(a !== null || b !== null) && (
          <TB onClick={() => setRange([null, null])} title="Play all frames">
            Clear
          </TB>
        )}
        {ed !== null && es !== null && (
          <TB onClick={() => setRange([Math.min(ed, es), Math.max(ed, es)])} title="Play systole only (ED → ES)">
            ED→ES
          </TB>
        )}
      </div>
    </div>
  );
}
