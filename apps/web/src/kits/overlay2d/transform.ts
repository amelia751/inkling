import OpenSeadragon from "openseadragon";
import type { Pt } from "@/types";

/**
 * Affine map between level-0 image pixels and viewer-element CSS pixels, rebuilt from
 * OpenSeadragon's own coordinate conversions once per frame. Rotation is part of OSD's
 * pixelFromPoint; horizontal flip is not (OSD mirrors the drawer and mirrors pointer
 * positions itself), so it is composed here. Drawing everything through this matrix
 * means overlays follow pan, zoom, rotation and flip with no per-point OSD calls.
 *
 *   sx = a·x + c·y + e
 *   sy = b·x + d·y + f
 */
export class View {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  /** Screen CSS px per image px (rotation-invariant). */
  scale = 1;
  width = 0;
  height = 0;
  private ia = 1;
  private ib = 0;
  private ic = 0;
  private id = 1;

  update(viewer: OpenSeadragon.Viewer, imageW: number, imageH: number) {
    const vp = viewer.viewport;
    const size = vp.getContainerSize();
    this.width = size.x;
    this.height = size.y;
    const p0 = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const px = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(imageW, 0));
    const py = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, imageH));
    let a = (px.x - p0.x) / imageW, b = (px.y - p0.y) / imageW;
    let c = (py.x - p0.x) / imageH;
    const d = (py.y - p0.y) / imageH;
    let e = p0.x;
    const f = p0.y;
    if (vp.getFlip()) {
      a = -a;
      c = -c;
      e = size.x - e;
    }
    Object.assign(this, { a, b, c, d, e, f });
    this.scale = Math.hypot(a, b);
    const det = a * d - b * c || 1e-12;
    this.ia = d / det;
    this.ib = -b / det;
    this.ic = -c / det;
    this.id = a / det;
  }

  toScreen(x: number, y: number): Pt {
    return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f];
  }

  toImage(sx: number, sy: number): Pt {
    const dx = sx - this.e, dy = sy - this.f;
    return [this.ia * dx + this.ic * dy, this.ib * dx + this.id * dy];
  }

  /** Axis-aligned image-space bounds of the visible viewer area (handles rotation). */
  visibleImageBounds(pad = 0): [number, number, number, number] {
    const corners = [this.toImage(-pad, -pad), this.toImage(this.width + pad, -pad), this.toImage(-pad, this.height + pad), this.toImage(this.width + pad, this.height + pad)];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of corners) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return [minX, minY, maxX, maxY];
  }

  /** Apply image→screen as the canvas transform (dpr folded in). */
  apply(ctx: CanvasRenderingContext2D, dpr: number) {
    ctx.setTransform(this.a * dpr, this.b * dpr, this.c * dpr, this.d * dpr, this.e * dpr, this.f * dpr);
  }
}
