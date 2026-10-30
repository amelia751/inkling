import type { Pt } from "@studio/contracts/types";

/**
 * Image ↔ screen mapping for a 2D overlay. The engine, tools, scene drawing and hit-tests
 * only see this interface, so any renderer can host kits/overlay2d: OpenSeadragon (the
 * wsi module rebuilds a `View` from OSD each frame), a pan/zoom camera (`View.setCamera`,
 * matching `useViewport2D`), or anything else that is an affine map.
 *
 * "Image" means item coordinates (level-0 pixels for a slide, frame pixels for video);
 * "screen" means CSS pixels relative to the overlay's stage element.
 */
export interface Transform2D {
  /** Screen CSS px per image px (rotation-invariant). */
  readonly scale: number;
  /** Stage size in CSS px. */
  readonly width: number;
  readonly height: number;
  toScreen(x: number, y: number): Pt;
  toImage(sx: number, sy: number): Pt;
  /** Axis-aligned image-space bounds of the visible stage (handles rotation). */
  visibleImageBounds(pad?: number): [number, number, number, number];
  /** Apply image→screen as the canvas transform (dpr folded in). */
  apply(ctx: CanvasRenderingContext2D, dpr: number): void;
}

/** A pan/zoom camera (useViewport2D's `Camera`), optionally rotated (degrees, about the stage centre) and mirrored. */
export interface CameraState {
  scale: number;
  tx: number;
  ty: number;
  rotation?: number;
  flipX?: boolean;
}

/**
 * Affine image→screen map:
 *
 *   sx = a·x + c·y + e
 *   sy = b·x + d·y + f
 *
 * Drawing everything through this matrix means overlays follow pan, zoom, rotation and
 * flip with no per-point host calls.
 */
export class View implements Transform2D {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;
  scale = 1;
  width = 0;
  height = 0;
  private ia = 1;
  private ib = 0;
  private ic = 0;
  private id = 1;

  /** Set the matrix directly (any host that can express its view as an affine map). */
  setMatrix(a: number, b: number, c: number, d: number, e: number, f: number, width: number, height: number): this {
    Object.assign(this, { a, b, c, d, e, f, width, height });
    this.scale = Math.hypot(a, b);
    const det = a * d - b * c || 1e-12;
    this.ia = d / det;
    this.ib = -b / det;
    this.ic = -c / det;
    this.id = a / det;
    return this;
  }

  /**
   * From a pan/zoom camera: screen = centre + Rot·Flip·(tx + x·scale − cx, ty + y·scale − cy),
   * i.e. the camera's own mapping, then rotated / mirrored about the stage centre.
   */
  setCamera(cam: CameraState, width: number, height: number): this {
    const s = cam.scale;
    const r = ((cam.rotation ?? 0) * Math.PI) / 180;
    const cos = Math.cos(r), sin = Math.sin(r), fx = cam.flipX ? -1 : 1;
    const cx = width / 2, cy = height / 2;
    const qx = cam.tx - cx, qy = cam.ty - cy;
    return this.setMatrix(cos * fx * s, sin * fx * s, -sin * s, cos * s, cx + cos * fx * qx - sin * qy, cy + sin * fx * qx + cos * qy, width, height);
  }

  toScreen(x: number, y: number): Pt {
    return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f];
  }

  toImage(sx: number, sy: number): Pt {
    const dx = sx - this.e, dy = sy - this.f;
    return [this.ia * dx + this.ic * dy, this.ib * dx + this.id * dy];
  }

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

  apply(ctx: CanvasRenderingContext2D, dpr: number) {
    ctx.setTransform(this.a * dpr, this.b * dpr, this.c * dpr, this.d * dpr, this.e * dpr, this.f * dpr);
  }
}
