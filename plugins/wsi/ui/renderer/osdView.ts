import OpenSeadragon from "openseadragon";
import type { View } from "@studio/studio-renderers/overlay2d/transform";

/**
 * The OpenSeadragon adapter for kits/overlay2d's transform: rebuild the affine
 * level-0-pixel → viewer-element map from OSD's own conversions, once per frame. Rotation
 * is part of OSD's pixelFromPoint; horizontal flip is not (OSD mirrors the drawer and
 * pointer positions itself), so it is composed here.
 */
export function syncViewFromOSD(view: View, viewer: OpenSeadragon.Viewer, imageW: number, imageH: number): View {
  const vp = viewer.viewport;
  const size = vp.getContainerSize();
  const p0 = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
  const px = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(imageW, 0));
  const py = vp.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, imageH));
  let a = (px.x - p0.x) / imageW, c = (py.x - p0.x) / imageH, e = p0.x;
  const b = (px.y - p0.y) / imageW, d = (py.y - p0.y) / imageH, f = p0.y;
  if (vp.getFlip()) {
    a = -a;
    c = -c;
    e = size.x - e;
  }
  return view.setMatrix(a, b, c, d, e, f, size.x, size.y);
}
