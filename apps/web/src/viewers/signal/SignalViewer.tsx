import { useEffect, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { seedUrl } from "@/lib/api";
import { resolveLabelColor, resolveToken } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { newAnnotation, useStudio } from "@/stores/studio";
import { CanvasNotice } from "@/viewers/image2d/Image2DViewer";
import { useCanvasSize } from "@/viewers/useCanvasSize";
import type { ViewerProps } from "@/viewers/ViewerAdapter";

interface Recording {
  record: string;
  fs: number;
  samples: number;
  dx: string;
  leads: Record<string, number[]>;
}

const WINDOWS = [10, 5, 2.5, 1];
const GUTTER = 44;
/** ±mV shown per lead row. */
const MV_RANGE = 1.5;

export function SignalViewer({ project, item }: ViewerProps) {
  const { containerRef, canvasRef, size } = useCanvasSize();
  const [rec, setRec] = useState<Recording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowSec, setWindowSec] = useState(10);
  const [offset, setOffset] = useState(0);
  const drag = useRef<{ lead: string; t0: number; t1: number } | null>(null);
  const [, redraw] = useState(0);

  const tool = useStudio((s) => s.tool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const annotations = useStudio((s) => s.annotations);
  const add = useStudio((s) => s.add);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);
  const labels = project.labels ?? [];

  useEffect(() => {
    let live = true;
    setRec(null);
    setError(null);
    setOffset(0);
    fetch(seedUrl(item.assets[0].path))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((r: Recording) => live && setRec(r))
      .catch(() => live && setError("This recording could not be loaded."));
    return () => {
      live = false;
    };
  }, [item]);

  const duration = rec ? rec.samples / rec.fs : 10;
  const maxOffset = Math.max(0, duration - windowSec);

  useEffect(() => {
    if (rec) setViewerStatus(`${rec.fs} Hz · ${Object.keys(rec.leads).length} leads · ${offset.toFixed(2)}–${(offset + windowSec).toFixed(2)} s of ${duration.toFixed(0)} s`);
  }, [rec, offset, windowSec, duration, setViewerStatus]);

  const leadNames = rec ? Object.keys(rec.leads) : [];
  const rowH = leadNames.length ? size.height / leadNames.length : 0;
  const plotW = size.width - GUTTER;
  const xOf = (t: number) => GUTTER + ((t - offset) / windowSec) * plotW;
  const tOf = (x: number) => offset + ((x - GUTTER) / plotW) * windowSec;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !size.width || !rec) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    // ECG paper: minor 0.04 s, major 0.2 s.
    const pxPerSec = plotW / windowSec;
    for (const [step, alpha] of [[0.04, 0.05], [0.2, 0.12]] as const) {
      if (pxPerSec * step < 4) continue;
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.beginPath();
      for (let t = Math.ceil(offset / step) * step; t <= offset + windowSec; t += step) {
        const x = Math.round(xOf(t)) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.height);
      }
      ctx.stroke();
    }

    const trace = resolveToken("--canvas-foreground", 0.9);
    leadNames.forEach((lead, row) => {
      const top = row * rowH;
      const mid = top + rowH / 2;
      // Interval annotations on this lead.
      for (const a of annotations) {
        if (a.itemId !== item.id || a.geometry.type !== "interval" || a.geometry.lead !== lead) continue;
        const x0 = xOf(a.geometry.start);
        const x1 = xOf(a.geometry.end);
        if (x1 < GUTTER || x0 > size.width) continue;
        ctx.fillStyle = resolveLabelColor(labels, a.label, 0.25);
        ctx.fillRect(x0, top + 1, x1 - x0, rowH - 2);
        ctx.fillStyle = resolveLabelColor(labels, a.label, 1);
        ctx.fillRect(x0, top + 1, x1 - x0, 2);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(GUTTER, top + rowH);
      ctx.lineTo(size.width, top + rowH);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = "11px Inter, sans-serif";
      ctx.fillText(lead, 8, mid + 4);

      const samples = rec.leads[lead];
      const i0 = Math.max(0, Math.floor(offset * rec.fs));
      const i1 = Math.min(samples.length, Math.ceil((offset + windowSec) * rec.fs) + 1);
      ctx.strokeStyle = trace;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = i0; i < i1; i++) {
        const x = xOf(i / rec.fs);
        const y = mid - (samples[i] / MV_RANGE) * (rowH / 2);
        if (i === i0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    const d = drag.current;
    if (d && activeLabel) {
      const row = leadNames.indexOf(d.lead);
      ctx.fillStyle = resolveLabelColor(labels, activeLabel, 0.3);
      ctx.fillRect(xOf(Math.min(d.t0, d.t1)), row * rowH, Math.abs(xOf(d.t1) - xOf(d.t0)), rowH);
    }
  });

  const locate = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const row = Math.floor((e.clientY - rect.top) / rowH);
    return { t: Math.max(0, Math.min(duration, tOf(x))), lead: leadNames[row], inPlot: x >= GUTTER };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool !== "interval" || !activeLabel) return;
    const { t, lead, inPlot } = locate(e);
    if (!lead || !inPlot) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { lead, t0: t, t1: t };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current.t1 = locate(e).t;
    redraw((n) => n + 1);
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !activeLabel) return;
    const start = Math.min(d.t0, d.t1);
    const end = Math.max(d.t0, d.t1);
    if (end - start >= 0.01) {
      add(newAnnotation({ itemId: item.id, label: activeLabel, geometry: { type: "interval", lead: d.lead, start: +start.toFixed(3), end: +end.toFixed(3) } }));
    } else {
      redraw((n) => n + 1);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / 400;
    setOffset((o) => Math.max(0, Math.min(maxOffset, o + delta * windowSec)));
  };

  return (
    <div className="flex h-full flex-col bg-canvas text-canvas-foreground">
      <div className="flex items-center gap-1 border-b border-white/10 px-3 py-1.5 text-xs">
        <span className="mr-1 text-canvas-foreground/60">Window</span>
        {WINDOWS.map((w) => (
          <button
            key={w}
            onClick={() => {
              setWindowSec(w);
              setOffset((o) => Math.min(o, Math.max(0, duration - w)));
            }}
            className={cn("tnum rounded-md px-2 py-0.5 transition-colors", w === windowSec ? "bg-primary text-primary-foreground" : "text-canvas-foreground/70 hover:bg-white/10")}
          >
            {w}s
          </button>
        ))}
        {rec?.dx && <span className="ml-auto truncate text-canvas-foreground/60">Source Dx codes: {rec.dx}</span>}
      </div>
      <div ref={containerRef} className="relative min-h-0 flex-1" onWheel={onWheel}>
        <canvas
          ref={canvasRef}
          style={{ width: size.width, height: size.height, cursor: tool === "interval" ? "col-resize" : "default" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          data-testid="signal-canvas"
        />
        {!rec && !error && <CanvasNotice>Loading recording…</CanvasNotice>}
        {error && <CanvasNotice>{error}</CanvasNotice>}
      </div>
      <div className="px-3 py-2">
        <Slider value={[offset]} min={0} max={maxOffset || 0.001} step={0.01} disabled={!maxOffset} onValueChange={([o]) => setOffset(o)} aria-label="Time offset" />
      </div>
    </div>
  );
}
