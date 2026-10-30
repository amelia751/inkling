import { useCallback, useEffect, useRef, useState } from "react";

export interface Camera {
  /** Screen pixels per content unit. */
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Pan/zoom camera for a content rectangle (`width`×`height` content units, e.g. pixels
 * scaled by physical spacing) inside a `size` viewport. Re-fits when the content or
 * viewport changes size; wheel zooms about the cursor; `startPan` drags.
 */
export function useViewport2D(content: { width: number; height: number }, size: { width: number; height: number }, margin = 0.94) {
  const [camera, setCamera] = useState<Camera>({ scale: 1, tx: 0, ty: 0 });
  const pan = useRef<{ x: number; y: number; camera: Camera } | null>(null);

  const fit = useCallback(() => {
    if (!content.width || !size.width) return;
    const scale = Math.min(size.width / content.width, size.height / content.height) * margin;
    setCamera({ scale, tx: (size.width - content.width * scale) / 2, ty: (size.height - content.height * scale) / 2 });
  }, [content.width, content.height, size.width, size.height, margin]);

  useEffect(fit, [fit]);

  /** Zoom by `factor` about a screen point (defaults to the viewport centre). */
  const zoomAt = useCallback(
    (factor: number, sx = size.width / 2, sy = size.height / 2) =>
      setCamera((c) => {
        const scale = Math.min(c.scale * 64, Math.max(c.scale / 64, c.scale * factor));
        const k = scale / c.scale;
        return { scale, tx: sx - (sx - c.tx) * k, ty: sy - (sy - c.ty) * k };
      }),
    [size.width, size.height],
  );

  /** 1 content unit = 1 screen pixel, centred. */
  const actualSize = useCallback(() => {
    setCamera({ scale: 1, tx: (size.width - content.width) / 2, ty: (size.height - content.height) / 2 });
  }, [size.width, size.height, content.width, content.height]);

  const onWheel = useCallback(
    (e: React.WheelEvent, rect: DOMRect) => zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top),
    [zoomAt],
  );

  const startPan = (e: React.PointerEvent) => {
    pan.current = { x: e.clientX, y: e.clientY, camera };
  };
  /** Returns true while a pan drag is in progress (so callers can skip tool handling). */
  const movePan = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return false;
    setCamera({ ...p.camera, tx: p.camera.tx + e.clientX - p.x, ty: p.camera.ty + e.clientY - p.y });
    return true;
  };
  const endPan = () => {
    const was = !!pan.current;
    pan.current = null;
    return was;
  };

  const toScreen = useCallback((x: number, y: number): [number, number] => [camera.tx + x * camera.scale, camera.ty + y * camera.scale], [camera]);
  const toContent = useCallback((sx: number, sy: number): [number, number] => [(sx - camera.tx) / camera.scale, (sy - camera.ty) / camera.scale], [camera]);

  return { camera, setCamera, fit, zoomAt, actualSize, onWheel, startPan, movePan, endPan, toScreen, toContent };
}
