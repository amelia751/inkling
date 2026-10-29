import { resolveLabelColor, resolveToken } from "@/lib/labels";
import type { Provenance } from "@/types";

/** Pixels within which a click on the first vertex closes an in-progress polygon. */
export const CLOSE_RADIUS = 8;

/**
 * Stroke a contour already projected to screen space. AI suggestions use the lime
 * provenance color with a dashed line so they can never be mistaken for human work.
 */
export function drawPolygon(
  ctx: CanvasRenderingContext2D,
  pts: [number, number][],
  opts: { labels: string[]; label: string; provenance?: Provenance; closed: boolean; selected?: boolean },
) {
  if (!pts.length) return;
  const ai = opts.provenance === "ai-suggested";
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
  if (opts.closed) {
    ctx.closePath();
    ctx.fillStyle = resolveLabelColor(opts.labels, opts.label, opts.selected ? 0.3 : 0.15);
    ctx.fill();
  }
  ctx.strokeStyle = ai ? resolveToken("--prov-ai") : resolveLabelColor(opts.labels, opts.label);
  ctx.lineWidth = opts.selected ? 3 : 2;
  ctx.setLineDash(ai || !opts.closed ? [6, 4] : []);
  ctx.stroke();
  if (!opts.closed) {
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    for (const [i, [x, y]] of pts.entries()) {
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 4.5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export function pointInPolygon([x, y]: [number, number], pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
