import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { hslToRgb, resolveLabelColor } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { newAnnotation, useStudio } from "@/stores/studio";
import type { Plane } from "@/types";
import { CanvasNotice } from "@/viewers/image2d/Image2DViewer";
import { useCanvasSize } from "@/viewers/useCanvasSize";
import type { ViewerProps } from "@/viewers/ViewerAdapter";
import { loadVolume, type Volume } from "./nifti";

type Ijk = [number, number, number];

/** BraTS label values → index into the project's label list. */
const SEG_LABEL_INDEX: Record<number, number> = { 1: 0, 2: 1, 4: 2 };

/** Which voxel axis each plane slices along, and which axes run across (u) and up (v). */
const PLANE_AXES: Record<Plane, { fixed: 0 | 1 | 2; u: 0 | 1 | 2; v: 0 | 1 | 2 }> = {
  axial: { fixed: 2, u: 0, v: 1 },
  coronal: { fixed: 1, u: 0, v: 2 },
  sagittal: { fixed: 0, u: 1, v: 2 },
};

export function Volume3DViewer({ project, item }: ViewerProps) {
  const sequences = item.assets.filter((a) => a.sequence !== "seg");
  const segAsset = item.assets.find((a) => a.sequence === "seg");
  const [sequence, setSequence] = useState(() => (sequences.find((a) => a.sequence === "flair") ?? sequences[0])?.sequence);
  const [volume, setVolume] = useState<Volume | null>(null);
  const [seg, setSeg] = useState<Volume | null>(null);
  const [showSeg, setShowSeg] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Ijk | null>(null);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);

  useEffect(() => {
    const asset = sequences.find((a) => a.sequence === sequence);
    if (!asset) return;
    let live = true;
    setError(null);
    loadVolume(asset.path)
      .then((v) => {
        if (!live) return;
        setVolume(v);
        setCursor((c) => c ?? [v.dims[0] >> 1, v.dims[1] >> 1, v.dims[2] >> 1]);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, sequence]);

  useEffect(() => {
    setSeg(null);
    setCursor(null);
    if (segAsset) loadVolume(segAsset.path).then(setSeg, () => setSeg(null));
  }, [segAsset]);

  useEffect(() => {
    if (!volume || !cursor) return;
    const [sx, sy, sz] = volume.spacing.map((s) => s.toFixed(1));
    setViewerStatus(
      `Axial ${cursor[2] + 1}/${volume.dims[2]} · Coronal ${cursor[1] + 1}/${volume.dims[1]} · Sagittal ${cursor[0] + 1}/${volume.dims[0]} · ${sx}×${sy}×${sz} mm`,
    );
  }, [volume, cursor, setViewerStatus]);

  if (error) return <div className="relative h-full bg-canvas"><CanvasNotice>{error}</CanvasNotice></div>;

  return (
    <div className="flex h-full flex-col bg-canvas text-canvas-foreground">
      <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5">
        <span className="mr-1 text-xs text-canvas-foreground/60">Sequence</span>
        {sequences.map((a) => (
          <button
            key={a.sequence}
            onClick={() => setSequence(a.sequence)}
            className={cn(
              "rounded-md px-2 py-0.5 text-xs uppercase tracking-wide transition-colors",
              a.sequence === sequence ? "bg-primary text-primary-foreground" : "text-canvas-foreground/70 hover:bg-white/10",
            )}
          >
            {a.sequence}
          </button>
        ))}
        {segAsset && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 text-xs text-canvas-foreground/80 hover:bg-white/10 hover:text-canvas-foreground"
            onClick={() => setShowSeg((s) => !s)}
            disabled={!seg}
          >
            {showSeg ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            Reference mask
          </Button>
        )}
      </div>
      {!volume || !cursor ? (
        <div className="relative flex-1"><CanvasNotice>Decoding volume…</CanvasNotice></div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-3 gap-px bg-white/10">
          {(["axial", "coronal", "sagittal"] as Plane[]).map((plane) => (
            <PlanePane
              key={plane}
              plane={plane}
              volume={volume}
              seg={showSeg ? seg : null}
              cursor={cursor}
              onCursor={setCursor}
              labels={project.labels ?? []}
              itemId={item.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PaneProps {
  plane: Plane;
  volume: Volume;
  seg: Volume | null;
  cursor: Ijk;
  onCursor: (c: Ijk) => void;
  labels: string[];
  itemId: string;
}

function PlanePane({ plane, volume, seg, cursor, onCursor, labels, itemId }: PaneProps) {
  const { containerRef, canvasRef, size } = useCanvasSize();
  const tool = useStudio((s) => s.tool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const annotations = useStudio((s) => s.annotations);
  const add = useStudio((s) => s.add);
  const axes = PLANE_AXES[plane];
  const [nx, ny] = volume.dims;
  const nu = volume.dims[axes.u];
  const nv = volume.dims[axes.v];
  const slice = cursor[axes.fixed];

  const segColors = useMemo(() => labels.map((l) => resolveLabelColor(labels, l, 1)), [labels]);

  // Rasterize the current slice at native resolution.
  const sliceCanvas = useMemo(() => {
    const off = document.createElement("canvas");
    off.width = nu;
    off.height = nv;
    const ctx = off.getContext("2d")!;
    const img = ctx.createImageData(nu, nv);
    const [lo, hi] = volume.window;
    const segRgb = segColors.map(hslToRgb);
    for (let v = 0; v < nv; v++) {
      for (let u = 0; u < nu; u++) {
        const ijk: Ijk = [0, 0, 0];
        ijk[axes.fixed] = slice;
        ijk[axes.u] = u;
        ijk[axes.v] = v;
        const idx = ijk[0] + ijk[1] * nx + ijk[2] * nx * ny;
        const g = Math.max(0, Math.min(255, ((volume.data[idx] - lo) / (hi - lo)) * 255));
        // Flip vertically so superior/anterior is up.
        const o = ((nv - 1 - v) * nu + u) * 4;
        let r = g, gg = g, b = g;
        const s = seg?.data[idx];
        if (s && SEG_LABEL_INDEX[s] !== undefined) {
          const [cr, cg, cb] = segRgb[SEG_LABEL_INDEX[s]] ?? [255, 255, 255];
          r = g * 0.55 + cr * 0.45;
          gg = g * 0.55 + cg * 0.45;
          b = g * 0.55 + cb * 0.45;
        }
        img.data[o] = r;
        img.data[o + 1] = gg;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return off;
  }, [volume, seg, slice, axes, nu, nv, nx, ny, segColors]);

  // Fit the slice into the pane, respecting physical voxel spacing.
  const layout = useMemo(() => {
    const w = nu * volume.spacing[axes.u];
    const h = nv * volume.spacing[axes.v];
    const scale = Math.min(size.width / w, size.height / h) * 0.95;
    return { scale, ox: (size.width - w * scale) / 2, oy: (size.height - h * scale) / 2, pu: volume.spacing[axes.u] * scale, pv: volume.spacing[axes.v] * scale };
  }, [size, nu, nv, volume.spacing, axes]);

  const points = annotations.filter(
    (a) => a.itemId === itemId && a.geometry.type === "point" && Math.abs(a.geometry.ijk[axes.fixed] - slice) <= 1,
  );

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sliceCanvas, layout.ox, layout.oy, nu * layout.pu, nv * layout.pv);
    const toScreen = (u: number, v: number) => [layout.ox + (u + 0.5) * layout.pu, layout.oy + (nv - 1 - v + 0.5) * layout.pv];
    // Crosshair through the other two planes' positions.
    const [cx, cy] = toScreen(cursor[axes.u], cursor[axes.v]);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, layout.oy);
    ctx.lineTo(cx, layout.oy + nv * layout.pv);
    ctx.moveTo(layout.ox, cy);
    ctx.lineTo(layout.ox + nu * layout.pu, cy);
    ctx.stroke();
    for (const a of points) {
      if (a.geometry.type !== "point") continue;
      const [px, py] = toScreen(a.geometry.ijk[axes.u], a.geometry.ijk[axes.v]);
      ctx.fillStyle = resolveLabelColor(labels, a.label);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  });

  const toVoxel = (e: React.PointerEvent): Ijk | null => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const u = Math.floor((e.clientX - rect.left - layout.ox) / layout.pu);
    const v = nv - 1 - Math.floor((e.clientY - rect.top - layout.oy) / layout.pv);
    if (u < 0 || v < 0 || u >= nu || v >= nv) return null;
    const ijk: Ijk = [...cursor];
    ijk[axes.u] = u;
    ijk[axes.v] = v;
    return ijk;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const ijk = toVoxel(e);
    if (!ijk) return;
    if (tool === "point" && activeLabel) {
      add(newAnnotation({ itemId, label: activeLabel, geometry: { type: "point", plane, slice, ijk } }));
    }
    onCursor(ijk);
  };

  const setSlice = (n: number) => {
    const next: Ijk = [...cursor];
    next[axes.fixed] = n;
    onCursor(next);
  };

  return (
    <div className="flex min-h-0 flex-col bg-canvas">
      <div className="flex items-center justify-between px-2 pt-1.5 text-[11px] uppercase tracking-wide text-canvas-foreground/60">
        <span>{plane}</span>
        <span className="tnum">{slice + 1} / {volume.dims[axes.fixed]}</span>
      </div>
      <div
        ref={containerRef}
        className="relative min-h-0 flex-1"
        onWheel={(e) => setSlice(Math.max(0, Math.min(volume.dims[axes.fixed] - 1, slice + Math.sign(e.deltaY))))}
      >
        <canvas
          ref={canvasRef}
          style={{ width: size.width, height: size.height, cursor: tool === "point" ? "crosshair" : "default" }}
          onPointerDown={onPointerDown}
          data-testid={`plane-${plane}`}
        />
      </div>
      <div className="px-3 pb-2">
        <Slider
          value={[slice]}
          min={0}
          max={volume.dims[axes.fixed] - 1}
          step={1}
          onValueChange={([n]) => setSlice(n)}
          aria-label={`${plane} slice`}
        />
      </div>
    </div>
  );
}
