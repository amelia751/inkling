import { useEffect, useRef, useState } from "react";

/**
 * Track a container's size and keep a HiDPI-backed canvas matched to it.
 * `containerRef` is a callback ref, so it works for containers that mount later
 * (e.g. after a volume finishes decoding).
 */
export function useCanvasSize() {
  const [container, containerRef] = useState<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!container) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [container]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.width * dpr;
    canvas.height = size.height * dpr;
  }, [size]);

  return { containerRef, canvasRef, size };
}
