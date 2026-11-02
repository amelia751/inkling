import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/** Delay for the i-th [data-reveal] child of a section (80 ms apart). */
export const stagger = (i: number) => ({ "--i": i }) as CSSProperties;

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** True while the element is on screen (`once`: stays true after the first time). */
export function useInView<T extends Element>(ref: RefObject<T | null>, { once = false, margin = "0px 0px -15% 0px" } = {}): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      setInView(e.isIntersecting);
      if (e.isIntersecting && once) io.disconnect();
    }, { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, once, margin]);
  return inView;
}

/** A ref that marks its element `data-shown` the first time it scrolls into view (drives [data-reveal]). */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const shown = useInView(ref, { once: true });
  useEffect(() => {
    if (shown) ref.current?.setAttribute("data-shown", "");
  }, [shown]);
  return ref;
}

/** Steps through `count` states every `ms` while `running`; `restart` jumps to one and resets the timer. */
export function useCycle(count: number, ms: number, running: boolean) {
  const [index, setIndex] = useState(0);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setTimeout(() => setIndex((i) => (i + 1) % count), ms);
    return () => clearTimeout(id);
  }, [index, epoch, count, ms, running]);
  const restart = (i: number) => {
    setIndex(i);
    setEpoch((e) => e + 1);
  };
  return [index, restart] as const;
}

/** Counts from 0 to `to` over `ms` once `start` is true. */
export function useCountUp(to: number, start: boolean, ms = 1400): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!start) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setValue(to);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setValue(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, start, ms]);
  return value;
}

/** Runs `draw(t)` every frame while the canvas is visible; once (t = 0) under reduced motion. */
export function useCanvasLoop(
  ref: RefObject<HTMLCanvasElement | null>,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void,
) {
  const visible = useInView(ref, { margin: "0px" });
  const reduced = useReducedMotion();
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    const size = () => {
      const dpr = Math.min(devicePixelRatio, 2);
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return [width, height] as const;
    };
    let [w, h] = size();
    const ro = new ResizeObserver(() => {
      [w, h] = size();
      if (reduced || !visible) drawRef.current(ctx, w, h, 0);
    });
    ro.observe(canvas);
    const t0 = performance.now();
    const frame = (now: number) => {
      drawRef.current(ctx, w, h, (now - t0) / 1000);
      raf = requestAnimationFrame(frame);
    };
    if (reduced || !visible) drawRef.current(ctx, w, h, 0);
    else raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [ref, visible, reduced]);
}
