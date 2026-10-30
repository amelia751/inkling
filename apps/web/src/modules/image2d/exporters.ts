import { labelNames } from "@/platform/environment";
import { seedUrl } from "@/lib/api";
import type { Annotation, Pt, StudioItem } from "@/types";
import type { Exporter } from "@/platform/module";
import { polygonArea } from "@/kits/overlay2d/geometry";
import { toCocoRle } from "@/kits/cornerstone/rle";
import { NAMING } from "@studio/plugin-contracts/naming";

async function imageSize(item: StudioItem, annotations: Annotation[]): Promise<[number, number]> {
  const asset = item.assets[0];
  if (asset?.width && asset?.height) return [asset.width, asset.height];
  const mask = annotations.find((a) => a.itemId === item.id && a.geometry.type === "mask");
  if (mask?.geometry.type === "mask") return [mask.geometry.dims[0], mask.geometry.dims[1]];
  try {
    const res = await fetch(seedUrl(asset.path));
    const bmp = await createImageBitmap(await res.blob());
    const size: [number, number] = [bmp.width, bmp.height];
    bmp.close();
    return size;
  } catch {
    return [0, 0];
  }
}

function bboxOf(points: number[][]): [number, number, number, number] {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
}

function ellipsePolygon(cx: number, cy: number, rx: number, ry: number, n = 32): number[][] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * COCO detection/segmentation JSON. Boxes → bbox; polygons, freehand and ellipse ROIs →
 * polygon segmentation; masks → uncompressed RLE (column-major, COCO convention);
 * keypoints and probes → single-keypoint annotations. Whole-image class labels are kept
 * as `images[].inkling_class`; other measurements (length, angle…) go to
 * `inkling_measurements` since COCO has no slot for them.
 */
export const cocoExporter: Exporter = {
  id: "coco",
  label: "COCO JSON",
  description: "Boxes, polygons, RLE masks and keypoints in COCO format (pixel coordinates), plus image-level class labels.",
  filename: (project) => `${project.id}-coco.json`,
  async build({ project, items, annotations }) {
    const labels = labelNames(project.labels);
    const categories = labels.map((name, i) => ({ id: i + 1, name, supercategory: project.id }));
    const catId = (label: string) => labels.indexOf(label) + 1 || null;
    const sizes = new Map<string, [number, number]>();
    const queue = [...items];
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        for (let it = queue.shift(); it; it = queue.shift()) sizes.set(it.id, await imageSize(it, annotations));
      }),
    );
    const images = items.map((item, i) => {
      const cls = annotations.find((a) => a.itemId === item.id && a.geometry.type === "class");
      const [width, height] = sizes.get(item.id) ?? [0, 0];
      return {
        id: i + 1,
        file_name: item.assets[0]?.path ?? item.id,
        width,
        height,
        ...(cls ? { inkling_class: cls.label, inkling_class_id: catId(cls.label) } : {}),
      };
    });
    const imageId = new Map(items.map((item, i) => [item.id, i + 1]));
    const out: Record<string, unknown>[] = [];
    const measurements: Record<string, unknown>[] = [];
    for (const a of annotations) {
      const image_id = imageId.get(a.itemId);
      if (!image_id) continue;
      const g = a.geometry;
      const base = {
        id: out.length + 1,
        image_id,
        category_id: catId(a.label),
        iscrowd: 0,
        inkling_id: a.id,
        inkling_provenance: a.provenance,
      };
      if (g.type === "box") {
        out.push({ ...base, bbox: [g.x, g.y, g.w, g.h].map(r2), area: r2(g.w * g.h), segmentation: [] });
      } else if (g.type === "polygon" || (g.type === "measurement" && g.kind === "freehand-roi" && g.space === "image")) {
        const pts = g.points;
        if (pts.length < 3) continue;
        out.push({ ...base, bbox: bboxOf(pts).map(r2), area: r2(polygonArea(pts as Pt[])), segmentation: [pts.flatMap((p) => [r2(p[0]), r2(p[1])])] });
      } else if (g.type === "ellipse" || (g.type === "measurement" && g.kind === "ellipse-roi" && g.space === "image")) {
        let cx: number, cy: number, rx: number, ry: number;
        if (g.type === "ellipse") ({ cx, cy, rx, ry } = g);
        else {
          const [x, y, w, h] = bboxOf(g.points);
          [cx, cy, rx, ry] = [x + w / 2, y + h / 2, w / 2, h / 2];
        }
        const poly = ellipsePolygon(cx, cy, rx, ry);
        out.push({ ...base, bbox: [cx - rx, cy - ry, 2 * rx, 2 * ry].map(r2), area: r2(Math.PI * rx * ry), segmentation: [poly.flatMap((p) => p.map(r2))] });
      } else if (g.type === "measurement" && g.kind === "rectangle-roi" && g.space === "image") {
        const [x, y, w, h] = bboxOf(g.points);
        out.push({ ...base, bbox: [x, y, w, h].map(r2), area: r2(w * h), segmentation: [] });
      } else if (g.type === "keypoint" || (g.type === "measurement" && g.kind === "probe" && g.space === "image")) {
        const [x, y] = g.type === "keypoint" ? [g.x, g.y] : g.points[0];
        out.push({ ...base, keypoints: [r2(x), r2(y), 2], num_keypoints: 1, bbox: [r2(x), r2(y), 0, 0], area: 0 });
      } else if (g.type === "mask" && g.dims.length === 2) {
        const [w, h] = g.dims;
        const rle = toCocoRle(g.counts, w, h);
        let minX = w, minY = h, maxX = -1, maxY = -1;
        let at = 0;
        g.counts.forEach((run, k) => {
          if (k % 2 === 1)
            for (let i = at; i < at + run; i++) {
              const x = i % w, y = (i - x) / w;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          at += run;
        });
        out.push({ ...base, segmentation: rle, area: g.voxels ?? 0, bbox: maxX < 0 ? [0, 0, 0, 0] : [minX, minY, maxX - minX + 1, maxY - minY + 1] });
      } else if (g.type === "measurement") {
        measurements.push({ image_id, label: a.label, kind: g.kind, points: g.points, unit: g.unit, stats: g.stats, text: g.text, inkling_id: a.id });
      }
    }
    const doc = {
      info: { description: project.title, version: "1.0", date_created: new Date().toISOString(), contributor: `${NAMING.displayName}` },
      licenses: [{ id: 1, name: project.license }],
      images,
      categories,
      annotations: out,
      ...(measurements.length ? { inkling_measurements: measurements } : {}),
    };
    return new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  },
};
