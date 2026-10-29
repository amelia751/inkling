import { useCallback, useEffect, useRef, useState } from "react";
import OpenSeadragon from "openseadragon";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { seedUrl } from "@/lib/api";
import { resolveLabelColor, resolveToken } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { newAnnotation, useStudio } from "@/stores/studio";
import { CLOSE_RADIUS, drawPolygon } from "@/viewers/draw";
import { CanvasNotice } from "@/viewers/image2d/Image2DViewer";
import type { ViewerProps } from "@/viewers/ViewerAdapter";

const MAGNIFICATIONS = [1.25, 5, 10, 20, 40];

export function PathologyViewer({ project, item }: ViewerProps) {
  const asset = item.assets[0];
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [, bump] = useState(0);

  const tool = useStudio((s) => s.tool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const annotations = useStudio((s) => s.annotations);
  const add = useStudio((s) => s.add);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);
  const labels = project.labels ?? [];
  const objective = Number(asset.magnification) || 40;
  const mpp = asset.mpp ?? null;

  // Latest values for OpenSeadragon's long-lived event handlers.
  const live = useRef({ tool, activeLabel, draft, add, itemId: item.id });
  live.current = { tool, activeLabel, draft, add, itemId: item.id };

  useEffect(() => {
    if (!hostRef.current) return;
    setReady(false);
    setError(null);
    const viewer = OpenSeadragon({
      element: hostRef.current,
      tileSources: seedUrl(asset.path),
      showNavigationControl: false,
      showNavigator: true,
      navigatorPosition: "BOTTOM_RIGHT",
      // Fixed size: a ratio is computed before the resizable panel has laid out.
      navigatorAutoResize: false,
      navigatorAutoFade: false,
      navigatorWidth: "220px",
      navigatorHeight: `${Math.max(60, Math.round((220 * (asset.height ?? 1)) / (asset.width ?? 2)))}px`,
      navigatorBackground: "#121215",
      navigatorBorderColor: "rgba(255,255,255,0.15)",
      navigatorDisplayRegionColor: resolveToken("--primary"),
      visibilityRatio: 0.5,
      minZoomImageRatio: 0.5,
      maxZoomPixelRatio: 2,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: false },
      animationTime: 0.4,
      crossOriginPolicy: false,
    });
    viewerRef.current = viewer;
    const redraw = () => bump((n) => n + 1);
    viewer.addHandler("open", () => {
      setReady(true);
      redraw();
    });
    viewer.addHandler("open-failed", () => setError("This slide's tile pyramid could not be opened."));
    viewer.addHandler("update-viewport", redraw);
    viewer.addHandler("resize", redraw);

    viewer.addHandler("canvas-click", (e) => {
      const { tool, activeLabel, draft, add, itemId } = live.current;
      if (!e.quick || (tool !== "polygon" && tool !== "mark") || !activeLabel) return;
      e.preventDefaultAction = true;
      const img = viewer.viewport.viewerElementToImageCoordinates(e.position);
      if (tool === "mark") {
        add(newAnnotation({ itemId, label: activeLabel, geometry: { type: "mark", x: Math.round(img.x), y: Math.round(img.y) } }));
        return;
      }
      if (draft.length >= 3) {
        const first = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(draft[0][0], draft[0][1]));
        if (first.distanceTo(e.position) <= CLOSE_RADIUS) {
          add(newAnnotation({ itemId, label: activeLabel, geometry: { type: "polygon", points: draft } }));
          setDraft([]);
          return;
        }
      }
      setDraft([...draft, [Math.round(img.x), Math.round(img.y)]]);
    });
    viewer.addHandler("canvas-double-click", (e) => {
      const { tool, activeLabel, draft, add, itemId } = live.current;
      if (tool !== "polygon") return;
      e.preventDefaultAction = true;
      if (draft.length >= 3 && activeLabel) add(newAnnotation({ itemId, label: activeLabel, geometry: { type: "polygon", points: draft } }));
      setDraft([]);
    });

    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
  }, [asset.path, asset.width, asset.height]);

  useEffect(() => setDraft([]), [tool, item.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Escape") setDraft([]);
      if (e.key === "Enter" && draft.length >= 3 && activeLabel) {
        add(newAnnotation({ itemId: item.id, label: activeLabel, geometry: { type: "polygon", points: draft } }));
        setDraft([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, activeLabel, add, item.id]);

  const imageZoom = useCallback(() => {
    const v = viewerRef.current;
    if (!v?.world.getItemCount()) return 0;
    return v.viewport.viewportToImageZoom(v.viewport.getZoom(true));
  }, []);

  const zoomToMagnification = (mag: number) => {
    const v = viewerRef.current;
    if (!v) return;
    v.viewport.zoomTo(v.viewport.imageToViewportZoom(mag / objective));
  };

  // Overlay: annotations, in-progress contour, scale bar.
  const mine = annotations.filter((a) => a.itemId === item.id);
  const marks = mine.filter((a) => a.geometry.type === "mark").length;
  const regions = mine.filter((a) => a.geometry.type === "polygon").length;
  const zoom = imageZoom();
  const mag = zoom * objective;

  useEffect(() => {
    setViewerStatus(
      `${asset.width?.toLocaleString()}×${asset.height?.toLocaleString()}px · ${mag ? `${mag < 10 ? mag.toFixed(1) : Math.round(mag)}× of ${objective}×` : "…"}${mpp ? ` · ${mpp.toFixed(3)} µm/px` : ""} · ${regions} regions · ${marks} marks`,
    );
  });

  useEffect(() => {
    const viewer = viewerRef.current;
    const canvas = overlayRef.current;
    const host = hostRef.current;
    if (!viewer || !canvas || !host || !ready) return;
    const w = host.clientWidth;
    const h = host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const toScreen = ([x, y]: [number, number]): [number, number] => {
      const p = viewer.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(x, y));
      return [p.x, p.y];
    };
    for (const a of mine) {
      if (a.geometry.type === "polygon") {
        drawPolygon(ctx, a.geometry.points.map(toScreen), { labels, label: a.label, provenance: a.provenance, closed: true });
      } else if (a.geometry.type === "mark") {
        const [x, y] = toScreen([a.geometry.x, a.geometry.y]);
        if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = resolveLabelColor(labels, a.label);
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    if (draft.length && activeLabel) drawPolygon(ctx, draft.map(toScreen), { labels, label: activeLabel, closed: false });

    // Scale bar: pick a round physical length near 120 screen px.
    if (mpp && zoom) {
      const umPerPx = mpp / zoom;
      const target = 120 * umPerPx;
      const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((n) => n >= target * 0.6) ?? 10000;
      const len = nice / umPerPx;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(12, h - 36, len + 16, 26);
      ctx.fillStyle = "#fff";
      ctx.fillRect(20, h - 18, len, 3);
      ctx.font = "11px Inter, sans-serif";
      ctx.fillText(nice >= 1000 ? `${nice / 1000} mm` : `${nice} µm`, 20, h - 23);
    }
  });

  const navigable = tool === "pan" || tool === "select";

  return (
    <div className="relative h-full w-full bg-canvas text-canvas-foreground">
      <div ref={hostRef} className={cn("absolute inset-0", !navigable && "cursor-crosshair")} data-testid="wsi-viewer" />
      <canvas ref={overlayRef} className="pointer-events-none absolute left-0 top-0" />
      <div className="absolute left-3 top-3 flex items-center gap-1 rounded-lg bg-black/55 p-1 text-xs backdrop-blur">
        {MAGNIFICATIONS.filter((m) => m <= objective).map((m) => (
          <button
            key={m}
            onClick={() => zoomToMagnification(m)}
            className={cn("tnum rounded-md px-2 py-0.5 transition-colors", Math.abs(mag - m) / m < 0.08 ? "bg-primary text-primary-foreground" : "hover:bg-white/15")}
          >
            {m}×
          </button>
        ))}
        <span className="mx-0.5 h-4 w-px bg-white/20" />
        <button className="rounded-md p-1 hover:bg-white/15" aria-label="Zoom in" onClick={() => viewerRef.current?.viewport.zoomBy(1.5)}><ZoomIn className="h-3.5 w-3.5" /></button>
        <button className="rounded-md p-1 hover:bg-white/15" aria-label="Zoom out" onClick={() => viewerRef.current?.viewport.zoomBy(1 / 1.5)}><ZoomOut className="h-3.5 w-3.5" /></button>
        <button className="rounded-md p-1 hover:bg-white/15" aria-label="Fit slide" onClick={() => viewerRef.current?.viewport.goHome()}><Maximize2 className="h-3.5 w-3.5" /></button>
      </div>
      {draft.length > 0 && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-md bg-black/60 px-2 py-1 text-xs">
          {draft.length} points · click the first point, double-click or press Enter to close · Esc cancels
        </div>
      )}
      {!ready && !error && <CanvasNotice>Loading slide tiles…</CanvasNotice>}
      {error && <CanvasNotice>{error}</CanvasNotice>}
    </div>
  );
}
