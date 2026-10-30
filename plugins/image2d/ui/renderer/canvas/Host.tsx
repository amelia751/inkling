import { useEffect, useMemo, useRef, useState } from "react";
import { resolveLabelColor, resolveToken } from "@studio/plugin-ui-sdk/labels";
import { drawHandles, drawPolygon } from "@studio/renderers/overlay2d/draw";
import { drawShape, shapeUtil } from "@studio/renderers/overlay2d/shapes";
import { CanvasNotice } from "@studio/renderers/viewport-chrome/CanvasNotice";
import { CornerText } from "@studio/renderers/viewport-chrome/bar";
import { useCanvasSize } from "@studio/renderers/viewport-chrome/useCanvasSize";
import { labelNames } from "@studio/contracts/environment";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import type { Annotation, Geometry, Pt } from "@studio/contracts/types";
import { useHoldToPan } from "../holdToPan";
import { fitCamera, panBy, toImage, toScreen, zoomAbout, type Camera } from "./camera";
import { RasterEditor, type EditorEnv } from "./editor";
import { RES, ns } from "@studio/contracts/naming";
import { assetUrl, isEditable, newAnnotation, useCommands, useHost, visibleFor } from "@studio/plugin-ui-sdk";

const SCOPES = [ns("image2d"), ns("core")];

/** Dev-only handle for e2e tests (image pixel → client coordinates, camera). */
function exposeForTests(api: Record<string, unknown> | null) {
  if (!import.meta.env.DEV) return;
  const w = window as unknown as Record<string, unknown>;
  if (api) w[`__${RES}Raster`] = api;
  else delete w[`__${RES}Raster`];
}

/**
 * `inkling.image2d.renderers.canvas-raster`: a lightweight renderer for natural images
 * (PNG / JPEG / WebP) on a plain `<canvas>`. Pan and zoom through a camera; boxes,
 * polygons and keypoints drawn, hit-tested and edited through the overlay2d ShapeUtils
 * (`RasterEditor`). No Cornerstone, no window/level.
 */
export default function CanvasRasterHost({ project, item, runtime }: RendererProps) {
  const { containerRef, canvasRef, size } = useCanvasSize();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [camera, setCamera] = useState<Camera | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const [, redraw] = useState(0);
  const cam = useRef<Camera | null>(null);
  cam.current = camera;

  const annotations = useHost((s) => s.annotations);
  const selectedIds = useHost((s) => s.selectedIds);
  const hiddenLabels = useHost((s) => s.hiddenLabels);
  const lockedLabels = useHost((s) => s.lockedLabels);
  const outlineOnly = useHost((s) => s.outlineOnly);
  const opacity = useHost((s) => s.overlayOpacity);
  const tool = useHost((s) => s.tool);
  const setViewerStatus = useHost((s) => s.setViewerStatus);
  const labels = useMemo(() => labelNames(project.labels), [project.labels]);
  const asset = item.assets[0];

  // ---------------------------------------------------------------- image
  useEffect(() => {
    if (!asset) return;
    let live = true;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => live && setImage(img);
    img.onerror = () => live && setError("This image could not be decoded.");
    img.src = assetUrl(asset.path);
    return () => {
      live = false;
    };
  }, [asset]);

  const fit = useMemo(() => (image ? fitCamera(image.naturalWidth, image.naturalHeight, size.width, size.height) : null), [image, size.width, size.height]);
  // Fit on load and whenever the viewport resizes.
  useEffect(() => setCamera(fit), [fit]);

  // ---------------------------------------------------------------- editor
  const editor = useMemo(() => {
    const env: EditorEnv = {
      annotations: () => {
        const s = useHost.getState();
        return visibleFor(s.annotations, item.id, s.hiddenLabels).filter((a) => !!shapeUtil(a.geometry));
      },
      selectedIds: () => useHost.getState().selectedIds,
      editable: (a) => isEditable(a, useHost.getState().lockedLabels),
      toScreen: (x, y) => (cam.current ? toScreen(cam.current, x, y) : [x, y]),
      toImage: (sx, sy) => (cam.current ? toImage(cam.current, sx, sy) : [sx, sy]),
      size: () => (image ? [image.naturalWidth, image.naturalHeight] : [0, 0]),
      select: (id) => useHost.getState().select(id),
      toggle: (id) => useHost.getState().toggleSelect(id),
      create: (geometry: Geometry) => {
        const s = useHost.getState();
        if (!s.activeLabel) return s.setViewerStatus("Pick a label first");
        if (s.lockedLabels.includes(s.activeLabel)) return s.setViewerStatus(`“${s.activeLabel}” is locked`);
        s.add(newAnnotation({ itemId: item.id, label: s.activeLabel, geometry }));
      },
      commit: (changes) => useHost.getState().batch({ update: changes.map((c) => ({ id: c.id, patch: { geometry: c.geometry } })) }),
      pan: (dx, dy) => setCamera((c) => (c ? panBy(c, dx, dy) : c)),
    };
    return new RasterEditor(env);
  }, [item.id, image]);

  // A tool change abandons any half-drawn shape.
  useEffect(() => {
    editor.cancel();
    redraw((n) => n + 1);
  }, [tool, editor]);

  const panning = useHoldToPan(!!image);

  useCommands(
    {
      fitView: () => {
        if (!fit) return false;
        setCamera(fit);
      },
      finishShape: () => (editor.finish() ? redraw((n) => n + 1) : false),
      cancelShape: () => (editor.cancel() ? redraw((n) => n + 1) : false),
      removeLastVertex: () => (editor.removeLastVertex() ? redraw((n) => n + 1) : false),
    },
    { scope: SCOPES },
  );

  // ---------------------------------------------------------------- pointer
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!camera || (e.button !== 0 && e.button !== 1)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    editor.down(tool, local(e), { shift: e.shiftKey, mod: e.metaKey || e.ctrlKey }, panning || e.button === 1);
    redraw((n) => n + 1);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    setHover(p);
    if (editor.move(p)) redraw((n) => n + 1);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    editor.up(local(e));
    redraw((n) => n + 1);
  };

  // Wheel zoom about the cursor (non-passive so the page doesn't scroll).
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !fit) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      setCamera((cur) => (cur ? zoomAbout(cur, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, fit.scale) : cur));
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, [canvasRef, fit]);

  // ---------------------------------------------------------------- draw
  const items = useMemo(() => visibleFor(annotations, item.id, hiddenLabels).filter((a) => !!shapeUtil(a.geometry)), [annotations, item.id, hiddenLabels]);
  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    if (!image || !camera) return;
    ctx.imageSmoothingEnabled = camera.scale < 2;
    ctx.drawImage(image, camera.tx, camera.ty, image.naturalWidth * camera.scale, image.naturalHeight * camera.scale);

    const ts = (x: number, y: number) => toScreen(camera, x, y);
    const selected = new Set(selectedIds);
    ctx.globalAlpha = opacity;
    const draw = (a: Annotation) => {
      const g = editor.preview.get(a.id) ?? a.geometry;
      const sel = selected.has(a.id);
      const ai = a.provenance === "ai-suggested";
      drawShape(ctx, g, ts, {
        stroke: ai ? resolveToken("--prov-ai") : resolveLabelColor(labels, a.label),
        fill: outlineOnly ? undefined : resolveLabelColor(labels, a.label, sel ? 0.3 : 0.15),
        lineWidth: sel ? 3 : 2,
        dash: ai ? [6, 4] : undefined,
      });
    };
    for (const a of items) draw(a);
    ctx.globalAlpha = 1;
    for (const a of items) {
      if (!selected.has(a.id) || !isEditable(a, lockedLabels)) continue;
      const g = editor.preview.get(a.id) ?? a.geometry;
      const u = shapeUtil(g);
      if (u) drawHandles(ctx, u.handles(g).map(([x, y]) => ts(x, y)));
    }

    const d = editor.draft;
    if (d?.kind === "box") {
      const [x0, y0] = ts(d.a[0], d.a[1]), [x1, y1] = ts(d.b[0], d.b[1]);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = resolveLabelColor(labels, useHost.getState().activeLabel ?? "");
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.restore();
    } else if (d?.kind === "polygon") {
      const pts = [...d.points, ...(d.hover ? [d.hover] : [])].map(([x, y]) => ts(x, y));
      drawPolygon(ctx, pts, { labels, label: useHost.getState().activeLabel ?? "", closed: false });
    }
  });

  // ---------------------------------------------------------------- status, runtime, test hook
  const zoom = camera ? Math.round(camera.scale * 100) : 0;
  const at = hover && camera && image ? toImage(camera, hover[0], hover[1]) : null;
  const inside = at && image && at[0] >= 0 && at[1] >= 0 && at[0] < image.naturalWidth && at[1] < image.naturalHeight;
  useEffect(() => {
    if (!image) return;
    setViewerStatus([`${image.naturalWidth}×${image.naturalHeight} px`, `Zoom ${zoom}%`, inside ? `(${Math.floor(at![0])}, ${Math.floor(at![1])})` : ""].filter(Boolean).join(" · "));
  });
  useEffect(() => () => setViewerStatus(""), [setViewerStatus]);
  useEffect(() => {
    runtime.publish("viewportState", camera && image ? { zoom: camera.scale, pan: [camera.tx, camera.ty], width: image.naturalWidth, height: image.naturalHeight } : undefined);
  }, [runtime, camera, image]);

  useEffect(() => {
    if (!image) return;
    exposeForTests({
      size: [image.naturalWidth, image.naturalHeight],
      camera: () => cam.current,
      canvasOf: (x: number, y: number) => {
        const r = canvasRef.current!.getBoundingClientRect();
        const [sx, sy] = cam.current ? toScreen(cam.current, x, y) : [x, y];
        return [r.left + sx, r.top + sy];
      },
      draft: () => editor.draft,
    });
    return () => exposeForTests(null);
  }, [image, editor, canvasRef]);

  const cursor = editor.cursor(tool, hover, panning);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-canvas text-canvas-foreground">
      <canvas
        ref={canvasRef}
        data-testid="raster-canvas"
        className="absolute inset-0 h-full w-full touch-none"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={() => editor.finish() && redraw((n) => n + 1)}
        onContextMenu={(e) => e.preventDefault()}
      />
      {image && <CornerText tl={<div>{item.name}</div>} tr={<div>Zoom {zoom}%</div>} br={<div>{image.naturalWidth}×{image.naturalHeight} px</div>} />}
      {!image && !error && <CanvasNotice loading>Loading image…</CanvasNotice>}
      {error && <CanvasNotice>{error}</CanvasNotice>}
    </div>
  );
}
