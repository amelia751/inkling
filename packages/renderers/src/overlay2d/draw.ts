import { resolveLabelColor, resolveToken } from "@studio/plugin-ui-sdk/labels";
import type { Provenance } from "@studio/contracts/types";

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

/** Square edit handles on vertices; the hovered/active one is filled with the accent. */
export function drawHandles(ctx: CanvasRenderingContext2D, pts: [number, number][], active = -1, size = 7) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  for (const [i, [x, y]] of pts.entries()) {
    ctx.fillStyle = i === active ? resolveToken("--primary") : "#fff";
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
    ctx.strokeRect(x - size / 2, y - size / 2, size, size);
  }
  ctx.restore();
}

/** Small label tag anchored at a screen point (above-left of the shape). */
export function drawTag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, background: string) {
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = "12px Inter, sans-serif";
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = background;
  ctx.fillRect(x, y - 16, w, 16);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, x + 4, y - 4);
  ctx.restore();
}
