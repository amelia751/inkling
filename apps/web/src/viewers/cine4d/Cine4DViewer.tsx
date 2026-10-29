import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Pause, Play } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { hslToRgb, resolveLabelColor } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { newAnnotation, useStudio } from "@/stores/studio";
import type { Annotation } from "@/types";
import { CLOSE_RADIUS, drawPolygon } from "@/viewers/draw";
import { CanvasNotice } from "@/viewers/image2d/Image2DViewer";
import { useCanvasSize } from "@/viewers/useCanvasSize";
import type { ViewerProps } from "@/viewers/ViewerAdapter";
import { loadVolume, type Volume } from "@/viewers/volume3d/nifti";

const PLAY_FPS = 12;

export function Cine4DViewer({ project, item }: ViewerProps) {
  const cineAsset = item.assets.find((a) => a.role === "cine")!;
  const refAssets = item.assets.filter((a) => a.role === "reference");
  const [cine, setCine] = useState<Volume | null>(null);
  const [refs, setRefs] = useState<{ frame: number; phase: string; volume: Volume }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [slice, setSlice] = useState(0);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showRef, setShowRef] = useState(true);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const { containerRef, canvasRef, size } = useCanvasSize();

  const tool = useStudio((s) => s.tool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const annotations = useStudio((s) => s.annotations);
  const add = useStudio((s) => s.add);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);
  const labels = project.labels ?? [];

  useEffect(() => {
    let live = true;
    loadVolume(cineAsset.path)
      .then((v) => {
        if (!live) return;
        setCine(v);
        setSlice(v.dims[2] >> 1);
      })
      .catch((e: Error) => live && setError(e.message));
    Promise.all(refAssets.map(async (a) => ({ frame: a.frame ?? 0, phase: a.phase ?? "", volume: await loadVolume(a.path) })))
      .then((r) => live && setRefs(r))
      .catch(() => live && setRefs([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  useEffect(() => {
    if (!playing || !cine) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % cine.frames), 1000 / PLAY_FPS);
    return () => clearInterval(t);
  }, [playing, cine]);

  const phaseRef = refs.find((r) => r.frame === frame);

  useEffect(() => {
    if (!cine) return;
    const [sx, sy, sz] = cine.spacing.map((s) => s.toFixed(2));
    setViewerStatus(
      `Slice ${slice + 1}/${cine.dims[2]} · Frame ${frame + 1}/${cine.frames}${phaseRef ? ` (${phaseRef.phase})` : ""} · ${cine.dims[0]}×${cine.dims[1]} · ${sx}×${sy}×${sz} mm`,
    );
  }, [cine, slice, frame, phaseRef, setViewerStatus]);

  const contours = annotations.filter(
    (a): a is Annotation & { geometry: { type: "polygon" } } =>
      a.itemId === item.id && a.geometry.type === "polygon" && a.geometry.frame === frame && a.geometry.slice === slice,
  );
  const framesWithContours = useMemo(
    () => new Set(annotations.filter((a) => a.itemId === item.id && a.geometry.type === "polygon").map((a) => (a.geometry as { frame?: number }).frame)),
    [annotations, item.id],
  );

  // Rasterize the current slice/frame, blending the reference mask on ED/ES frames.
  const sliceCanvas = useMemo(() => {
    if (!cine) return null;
    const [nx, ny, nz] = cine.dims;
    const off = document.createElement("canvas");
    off.width = nx;
    off.height = ny;
    const ctx = off.getContext("2d")!;
    const img = ctx.createImageData(nx, ny);
    const [lo, hi] = cine.window;
    const base = frame * nx * ny * nz + slice * nx * ny;
    const mask = showRef ? phaseRef?.volume.data : undefined;
    const rgb = labels.map((l) => hslToRgb(resolveLabelColor(labels, l)));
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const g = Math.max(0, Math.min(255, ((cine.data[base + j * nx + i] - lo) / (hi - lo)) * 255));
        const o = (j * nx + i) * 4;
        const m = mask?.[slice * nx * ny + j * nx + i];
        if (m && rgb[m - 1]) {
          const [r, gg, b] = rgb[m - 1];
          img.data[o] = g * 0.55 + r * 0.45;
          img.data[o + 1] = g * 0.55 + gg * 0.45;
          img.data[o + 2] = g * 0.55 + b * 0.45;
        } else {
          img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
        }
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return off;
  }, [cine, frame, slice, showRef, phaseRef, labels]);

  const layout = useMemo(() => {
    if (!cine) return { scale: 1, ox: 0, oy: 0, px: 1, py: 1 };
    const w = cine.dims[0] * cine.spacing[0];
    const h = cine.dims[1] * cine.spacing[1];
    const scale = Math.min(size.width / w, size.height / h) * 0.94;
    return { scale, ox: (size.width - w * scale) / 2, oy: (size.height - h * scale) / 2, px: cine.spacing[0] * scale, py: cine.spacing[1] * scale };
  }, [cine, size]);

  const toScreen = useCallback(([i, j]: [number, number]): [number, number] => [layout.ox + i * layout.px, layout.oy + j * layout.py], [layout]);

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !size.width || !cine || !sliceCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sliceCanvas, layout.ox, layout.oy, cine.dims[0] * layout.px, cine.dims[1] * layout.py);
    for (const a of contours) drawPolygon(ctx, a.geometry.points.map(toScreen), { labels, label: a.label, provenance: a.provenance, closed: true });
    if (draft.length && activeLabel) drawPolygon(ctx, draft.map(toScreen), { labels, label: activeLabel, closed: false });
  });

  const commit = useCallback(
    (points: [number, number][]) => {
      if (points.length >= 3 && activeLabel) {
        add(newAnnotation({ itemId: item.id, label: activeLabel, geometry: { type: "polygon", points, frame, slice } }));
      }
      setDraft([]);
    },
    [activeLabel, add, item.id, frame, slice],
  );

  // A contour belongs to one frame and slice; moving away abandons it.
  useEffect(() => setDraft([]), [frame, slice, tool]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") setDraft([]);
      else if (e.key === "Enter" && draft.length) commit(draft);
      else if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === ",") setFrame((f) => (f - 1 + (cine?.frames ?? 1)) % (cine?.frames ?? 1));
      else if (e.key === ".") setFrame((f) => (f + 1) % (cine?.frames ?? 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, commit, cine]);

  if (error) return <div className="relative h-full bg-canvas"><CanvasNotice>{error}</CanvasNotice></div>;
  if (!cine) return <div className="relative h-full bg-canvas"><CanvasNotice>Decoding 4D cine volume…</CanvasNotice></div>;

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool !== "polygon" || !activeLabel) return;
    setPlaying(false);
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const i = (sx - layout.ox) / layout.px;
    const j = (sy - layout.oy) / layout.py;
    if (i < 0 || j < 0 || i > cine.dims[0] || j > cine.dims[1]) return;
    if (draft.length >= 3) {
      const [fx, fy] = toScreen(draft[0]);
      if (Math.hypot(fx - sx, fy - sy) <= CLOSE_RADIUS) return commit(draft);
    }
    setDraft((d) => [...d, [+i.toFixed(2), +j.toFixed(2)]]);
  };

  return (
    <div className="flex h-full flex-col bg-canvas text-canvas-foreground">
      <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5 text-xs">
        <span className="mr-1 text-canvas-foreground/60">Jump to</span>
        {refs.map((r) => (
          <button
            key={r.phase}
            onClick={() => {
              setPlaying(false);
              setFrame(r.frame);
            }}
            className={cn("rounded-md px-2 py-0.5 transition-colors", frame === r.frame ? "bg-primary text-primary-foreground" : "text-canvas-foreground/70 hover:bg-white/10")}
            title={r.phase === "ED" ? "End-diastole: heart most relaxed" : "End-systole: heart most contracted"}
          >
            {r.phase} · frame {r.frame + 1}
          </button>
        ))}
        <button
          onClick={() => setShowRef((s) => !s)}
          disabled={!refs.length}
          className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-0.5 text-canvas-foreground/80 hover:bg-white/10 disabled:opacity-40"
        >
          {showRef ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          Reference contours {phaseRef ? `(${phaseRef.phase})` : "· ED/ES only"}
        </button>
      </div>

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1"
        onWheel={(e) => setSlice((s) => Math.max(0, Math.min(cine.dims[2] - 1, s + Math.sign(e.deltaY))))}
      >
        <canvas
          ref={canvasRef}
          style={{ width: size.width, height: size.height, cursor: tool === "polygon" ? "crosshair" : "default" }}
          onPointerDown={onPointerDown}
          onDoubleClick={() => draft.length >= 3 && commit(draft)}
          data-testid="cine-canvas"
        />
        {draft.length > 0 && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-xs">
            {draft.length} points · click the first point, double-click or press Enter to close · Esc cancels
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-white/10 px-3 py-2 text-xs">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "Pause" : "Play"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary-hover"
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
          <span className="w-10 shrink-0 text-canvas-foreground/60">Time</span>
          <div className="relative flex-1">
            <Slider value={[frame]} min={0} max={cine.frames - 1} step={1} onValueChange={([f]) => setFrame(f)} aria-label="Cardiac phase (frame)" />
            <div className="pointer-events-none absolute -bottom-1.5 left-0 right-0 h-1">
              {Array.from({ length: cine.frames }, (_, f) => (
                <span
                  key={f}
                  className={cn("absolute h-1 w-1 -translate-x-1/2 rounded-full", refs.some((r) => r.frame === f) ? "bg-canvas-foreground/70" : framesWithContours.has(f) ? "bg-primary" : "")}
                  style={{ left: `${(f / Math.max(1, cine.frames - 1)) * 100}%` }}
                />
              ))}
            </div>
          </div>
          <span className="tnum w-14 shrink-0 text-right text-canvas-foreground/70">{frame + 1}/{cine.frames}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="w-7 shrink-0" />
          <span className="w-10 shrink-0 text-canvas-foreground/60">Slice</span>
          <Slider value={[slice]} min={0} max={cine.dims[2] - 1} step={1} onValueChange={([s]) => setSlice(s)} aria-label="Short-axis slice" className="flex-1" />
          <span className="tnum w-14 shrink-0 text-right text-canvas-foreground/70">{slice + 1}/{cine.dims[2]}</span>
        </div>
      </div>
    </div>
  );
}
