import { useCallback, useEffect, useRef, useState } from "react";
import { seedUrl } from "@/lib/api";
import { resolveLabelColor, resolveToken } from "@/lib/labels";
import { newAnnotation, useStudio } from "@/stores/studio";
import { useCanvasSize } from "@/viewers/useCanvasSize";
import type { ViewerProps } from "@/viewers/ViewerAdapter";

interface View {
  scale: number;
  tx: number;
  ty: number;
}

type Drag =
  | { kind: "pan"; startX: number; startY: number; view: View }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number };

export function Image2DViewer({ project, item }: ViewerProps) {
  const { containerRef, canvasRef, size } = useCanvasSize();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const [selected, setSelected] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const [, forceDraw] = useState(0);

  const tool = useStudio((s) => s.tool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const annotations = useStudio((s) => s.annotations);
  const add = useStudio((s) => s.add);
  const remove = useStudio((s) => s.remove);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);
  const labels = project.labels ?? [];
  const boxes = annotations.filter((a) => a.itemId === item.id && a.geometry.type === "box");

  useEffect(() => {
    setImage(null);
    setError(null);
    const img = new Image();
    img.onload = () => setImage(img);
    img.onerror = () => setError("This image could not be decoded.");
    img.src = seedUrl(item.assets[0].path);
  }, [item]);

  const fit = useCallback(() => {
    if (!image || !size.width) return;
    const scale = Math.min(size.width / image.width, size.height / image.height) * 0.92;
    setView({ scale, tx: (size.width - image.width * scale) / 2, ty: (size.height - image.height * scale) / 2 });
  }, [image, size.width, size.height]);

  useEffect(fit, [fit]);

  useEffect(() => {
    if (image) setViewerStatus(`${image.width}×${image.height}px · Zoom ${Math.round(view.scale * 100)}%`);
  }, [image, view.scale, setViewerStatus]);

  const toImage = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.tx) / view.scale, y: (clientY - rect.top - view.ty) / view.scale };
  };

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !size.width) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    if (!image) return;
    ctx.save();
    ctx.translate(view.tx, view.ty);
    ctx.scale(view.scale, view.scale);
    ctx.imageSmoothingEnabled = view.scale < 2;
    ctx.drawImage(image, 0, 0);
    const line = 2 / view.scale;
    for (const a of boxes) {
      if (a.geometry.type !== "box") continue;
      const { x, y, w, h } = a.geometry;
      const ai = a.provenance === "ai-suggested";
      ctx.strokeStyle = ai ? resolveToken("--prov-ai") : resolveLabelColor(labels, a.label);
      ctx.lineWidth = a.id === selected ? line * 2 : line;
      ctx.setLineDash(ai ? [6 / view.scale, 4 / view.scale] : []);
      ctx.fillStyle = resolveLabelColor(labels, a.label, a.id === selected ? 0.18 : 0.08);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.font = `${12 / view.scale}px Inter, sans-serif`;
      const tag = a.label;
      const tw = ctx.measureText(tag).width + 8 / view.scale;
      ctx.fillStyle = resolveLabelColor(labels, a.label, 0.9);
      ctx.fillRect(x, y - 16 / view.scale, tw, 16 / view.scale);
      ctx.fillStyle = "#fff";
      ctx.fillText(tag, x + 4 / view.scale, y - 4 / view.scale);
    }
    const d = drag.current;
    if (d?.kind === "box" && activeLabel) {
      ctx.strokeStyle = resolveLabelColor(labels, activeLabel);
      ctx.lineWidth = line;
      ctx.setLineDash([4 / view.scale, 3 / view.scale]);
      ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }
    ctx.restore();
  });

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = toImage(e.clientX, e.clientY);
    if (tool === "pan" || e.button === 1) {
      drag.current = { kind: "pan", startX: e.clientX, startY: e.clientY, view };
    } else if (tool === "box" && activeLabel) {
      drag.current = { kind: "box", x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    } else if (tool === "select") {
      const hit = [...boxes].reverse().find((a) => {
        if (a.geometry.type !== "box") return false;
        const { x, y, w, h } = a.geometry;
        return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
      });
      setSelected(hit?.id ?? null);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView({ ...d.view, tx: d.view.tx + e.clientX - d.startX, ty: d.view.ty + e.clientY - d.startY });
    } else {
      const p = toImage(e.clientX, e.clientY);
      d.x1 = p.x;
      d.y1 = p.y;
      forceDraw((n) => n + 1);
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind !== "box" || !activeLabel || !image) return;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    const x = clamp(Math.min(d.x0, d.x1), image.width);
    const y = clamp(Math.min(d.y0, d.y1), image.height);
    const w = clamp(Math.max(d.x0, d.x1), image.width) - x;
    const h = clamp(Math.max(d.y0, d.y1), image.height) - y;
    if (w > 3 && h > 3) {
      add(newAnnotation({ itemId: item.id, label: activeLabel, geometry: { type: "box", x, y, w, h } }));
    } else {
      forceDraw((n) => n + 1);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const scale = Math.min(20, Math.max(0.05, view.scale * factor));
    const k = scale / view.scale;
    setView({ scale, tx: mx - (mx - view.tx) * k, ty: my - (my - view.ty) * k });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selected && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        remove(selected);
        setSelected(null);
      }
      if (e.key === "0" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) fit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, remove, fit]);

  const cursor = tool === "pan" ? "grab" : tool === "box" ? "crosshair" : "default";

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-canvas">
      <canvas
        ref={canvasRef}
        style={{ width: size.width, height: size.height, cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        data-testid="image-canvas"
      />
      {!image && !error && <CanvasNotice>Loading image…</CanvasNotice>}
      {error && <CanvasNotice>{error}</CanvasNotice>}
    </div>
  );
}

export function CanvasNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-canvas-foreground/60">
      {children}
    </div>
  );
}
