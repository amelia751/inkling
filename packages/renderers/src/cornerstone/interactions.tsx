import { useEffect, useRef, useState } from "react";
import { useHotkeys } from "@studio/plugin-ui-sdk";
import { matches } from "@studio/ui/keys";

/**
 * Hold Space to pan with the primary button, whatever tool is active (Photoshop / OHIF
 * convention). `apply(true)` must bind Pan as the primary tool; `apply(false)` restores.
 */
export function useSpacePan(apply: (on: boolean) => void, enabled: boolean): boolean {
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useHotkeys(
    (e) => {
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey) return false;
      if (!heldRef.current) {
        heldRef.current = true;
        setHeld(true);
        applyRef.current(true);
      }
      return true;
    },
    undefined,
    enabled,
  );
  useEffect(() => {
    const release = (e: KeyboardEvent | FocusEvent) => {
      if (!heldRef.current || (e instanceof KeyboardEvent && e.code !== "Space")) return;
      heldRef.current = false;
      setHeld(false);
      applyRef.current(false);
    };
    window.addEventListener("keyup", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", release);
    };
  }, []);
  return held;
}

/** `m` toggles the magnifier (registry entry proposed as `toggleMagnifier`). */
export function useMagnifierKey(toggle: () => void, enabled: boolean) {
  useHotkeys((e) => (matches(e, "m") ? (toggle(), true) : false), undefined, enabled);
}

const LOUPE = 220;
const ZOOM = 3;

/**
 * Hover magnifier: copies the region under the pointer from the Cornerstone canvas it is
 * over (2D canvases fed by the rendering engine) into a loupe, at 3× with a crosshair.
 * Works for stack and volume viewports alike and never takes the mouse from the tool.
 */
export function Loupe({ root, enabled }: { root: HTMLElement | null; enabled: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!enabled || !root) {
      setPos(null);
      return;
    }
    const onMove = (e: MouseEvent) => {
      const canvases = [...root.querySelectorAll<HTMLCanvasElement>("canvas.cornerstone-canvas")];
      const src = canvases.find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      });
      const out = ref.current;
      if (!src || !out) {
        setPos(null);
        return;
      }
      const r = src.getBoundingClientRect();
      const sx = src.width / r.width, sy = src.height / r.height;
      const cx = (e.clientX - r.left) * sx, cy = (e.clientY - r.top) * sy;
      const w = (LOUPE / ZOOM) * sx, h = (LOUPE / ZOOM) * sy;
      const ctx = out.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, LOUPE, LOUPE);
      ctx.drawImage(src, cx - w / 2, cy - h / 2, w, h, 0, 0, LOUPE, LOUPE);
      ctx.strokeStyle = "rgba(250, 204, 21, 0.8)";
      ctx.beginPath();
      ctx.moveTo(LOUPE / 2, LOUPE / 2 - 10);
      ctx.lineTo(LOUPE / 2, LOUPE / 2 + 10);
      ctx.moveTo(LOUPE / 2 - 10, LOUPE / 2);
      ctx.lineTo(LOUPE / 2 + 10, LOUPE / 2);
      ctx.stroke();
      const host = root.getBoundingClientRect();
      // Keep the loupe beside the cursor and inside the viewer.
      let x = e.clientX - host.left + 24, y = e.clientY - host.top + 24;
      if (x + LOUPE > host.width) x -= LOUPE + 48;
      if (y + LOUPE > host.height) y -= LOUPE + 48;
      setPos({ x, y });
    };
    const onLeave = () => setPos(null);
    root.addEventListener("mousemove", onMove);
    root.addEventListener("mouseleave", onLeave);
    return () => {
      root.removeEventListener("mousemove", onMove);
      root.removeEventListener("mouseleave", onLeave);
    };
  }, [root, enabled]);
  if (!enabled) return null;
  return (
    <canvas
      ref={ref}
      width={LOUPE}
      height={LOUPE}
      data-testid="magnifier"
      className="pointer-events-none absolute z-20 rounded-full border-2 border-amber-300/80 shadow-lg"
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, width: LOUPE, height: LOUPE, visibility: pos ? "visible" : "hidden" }}
    />
  );
}

/**
 * Dev-only handle for end-to-end tests (e2e/*_test.py): lets them read camera / display
 * properties that have no DOM representation. Stripped from production builds.
 */
export function exposeForTests(name: string, api: Record<string, unknown> | null) {
  if (!import.meta.env.DEV) return;
  const w = window as unknown as Record<string, unknown>;
  if (api) w[name] = api;
  else delete w[name];
}
