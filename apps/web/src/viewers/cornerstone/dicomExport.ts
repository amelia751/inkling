import { cache, metaData, utilities as csUtils, type Types } from "@cornerstonejs/core";
import { adaptersSEG, adaptersSR } from "@cornerstonejs/adapters";
import { data as dcmjsData } from "dcmjs";
import type { Annotation, Project, StudioItem } from "@/types";
import { KIND_TOOL, labelRgb } from "./bridge";
import { isDicomPath, loadDicomSeries } from "./dicom";
import { ensureCornerstone } from "./init";
import { decodeMaskInto } from "./rle";

/**
 * DICOM SEG (masks) and DICOM SR TID 1500 (measurements) for items whose source images are
 * DICOM, built with @cornerstonejs/adapters and written with dcmjs. Loaded lazily by the
 * adapters' exporters, so Cornerstone stays out of the app shell.
 */

interface Ctx {
  project: Project;
  item: StudioItem;
  annotations: Annotation[];
}

async function sourceImageIds(item: StudioItem): Promise<string[]> {
  await ensureCornerstone();
  const paths = item.assets.map((a) => a.path).filter(isDicomPath);
  if (!paths.length) throw new Error(`DICOM export needs DICOM source images; “${item.name}” is not DICOM. Use the NIfTI / COCO export instead.`);
  // Same slice order as the viewer's volume (Cornerstone's own sort).
  const ids = await loadDicomSeries(paths);
  const vol = cache.getVolume(`cornerstoneStreamingImageVolume:ink:dicom:${paths[0]}:${paths.length}`);
  return vol?.imageIds?.length === ids.length ? vol.imageIds : ids;
}

const CATEGORY = { CodeValue: "91723000", CodingSchemeDesignator: "SCT", CodeMeaning: "Anatomical structure" };
const TYPE = { CodeValue: "85756007", CodingSchemeDesignator: "SCT", CodeMeaning: "Tissue" };

/**
 * Projection images have no slice geometry, so the adapter derives e.g. SpacingBetweenSlices
 * as NaN, which dcmjs refuses to write. Drop such attributes (they are optional there).
 */
function dropNaN(node: unknown, path: string) {
  if (!node || typeof node !== "object" || ArrayBuffer.isView(node) || node instanceof ArrayBuffer) return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.startsWith("_")) continue;
    // Keys that are not DICOM keywords (helper fields leaked into the dataset) would be
    // written with a NaN tag.
    if (!/^\d+$/.test(k) && !["Alphabetic", "Ideographic", "Phonetic"].includes(k) && !dcmjsData.DicomMetaDictionary.nameMap[k] && !/^[0-9A-Fa-f]{8}$/.test(k)) {
      console.warn(`[inkling] DICOM export: dropping non-DICOM attribute ${path}${k}`);
      delete (node as Record<string, unknown>)[k];
      continue;
    }
    const bad = (x: unknown) => typeof x === "number" && Number.isNaN(x);
    if (bad(v) || (Array.isArray(v) && v.some(bad))) {
      console.warn(`[inkling] DICOM export: dropping ${path}${k} (NaN)`);
      delete (node as Record<string, unknown>)[k];
    } else if (typeof v === "object") dropNaN(v, `${path}${k}.`);
  }
}

/** dcmjs' datasetToBlob goes through Node's Buffer; write the Part-10 bytes directly. */
function toBlob(dataset: unknown): Blob {
  dropNaN(dataset, "");
  return new Blob([dcmjsData.datasetToDict(dataset).write() as ArrayBuffer], { type: "application/dicom" });
}

const STUDY_KEYS = ["PatientName", "PatientID", "PatientBirthDate", "PatientSex", "PatientAge", "StudyInstanceUID", "StudyDate", "StudyTime", "StudyID", "StudyDescription", "AccessionNumber", "ReferringPhysicianName", "SpecificCharacterSet"];
const SERIES_KEYS = ["SeriesInstanceUID", "SeriesNumber", "SeriesDescription", "SeriesDate", "SeriesTime", "Modality", "FrameOfReferenceUID", "Manufacturer"];
const IMAGE_KEYS = ["SOPInstanceUID", "SOPClassUID", "InstanceNumber", "Rows", "Columns", "ImagePositionPatient", "ImageOrientationPatient", "PixelSpacing", "ImagerPixelSpacing", "SliceThickness", "SpacingBetweenSlices", "FrameOfReferenceUID", "NumberOfFrames"];

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/**
 * The adapters read naturalized DICOM (StudyData / SeriesData / ImageData / instance). The
 * viewers load images with the classic wadouri provider, whose modules are parsed objects,
 * so re-read the source files with dcmjs and serve naturalized datasets, deferring every
 * other module (image plane, SOP common…) to Cornerstone's metadata.
 */
async function naturalizedMetadata(imageIds: string[]) {
  const byId = new Map<string, Record<string, unknown>>();
  await Promise.all(
    imageIds.map(async (id) => {
      const url = id.replace(/^wadouri:/, "").split("&frame=")[0];
      const buf = await (await fetch(url)).arrayBuffer();
      const dict = dcmjsData.DicomMessage.readFile(buf);
      const nat = dcmjsData.DicomMetaDictionary.naturalizeDataset(dict.dict) as Record<string, unknown>;
      delete nat.PixelData;
      // Projection radiographs: same identity plane the viewer assumes.
      nat.ImagePositionPatient ??= [0, 0, 0];
      nat.ImageOrientationPatient ??= [1, 0, 0, 0, 1, 0];
      if (!nat.PixelSpacing && nat.ImagerPixelSpacing) nat.PixelSpacing = nat.ImagerPixelSpacing;
      nat.FrameOfReferenceUID ??= metaData.get("imagePlaneModule", id)?.frameOfReferenceUID;
      byId.set(id, nat);
    }),
  );
  return {
    get(type: string, id: string, ...rest: unknown[]) {
      const n = byId.get(id);
      if (n) {
        if (type === "StudyData") return pick(n, STUDY_KEYS);
        if (type === "SeriesData") return pick(n, SERIES_KEYS);
        if (type === "ImageData") return pick(n, IMAGE_KEYS);
        if (type === "instance") return n;
      }
      return (metaData.get as (t: string, i: string, ...r: unknown[]) => unknown)(type, id, ...rest);
    },
  };
}

/** One SEG instance with a segment per label that has a mask. */
export async function buildDicomSeg({ project, item, annotations }: Ctx): Promise<Blob> {
  const imageIds = await sourceImageIds(item);
  const images = imageIds.map((id) => cache.getImage(id)!);
  const { columns: w, rows: h } = images[0];
  const nz = imageIds.length;
  const labels = project.labels ?? [];
  const scalar = new Uint8Array(w * h * nz);
  const masks = annotations.filter((a) => a.itemId === item.id && a.geometry.type === "mask");
  for (const a of masks) {
    const g = a.geometry as Extract<Annotation["geometry"], { type: "mask" }>;
    if (g.dims.reduce((x, y) => x * y, 1) !== scalar.length) throw new Error(`Mask “${a.label}” does not match the image grid`);
    decodeMaskInto(g.counts, scalar, labels.indexOf(a.label) + 1);
  }
  // Frame k of the labelmap ↔ imageIds[k] (no flipping; the viewer's volume uses this order).
  const labelmaps2D: unknown[] = [];
  const present = new Set<number>();
  for (let k = 0; k < nz; k++) {
    const pixelData = scalar.slice(k * w * h, (k + 1) * w * h);
    const segs = [...new Set(pixelData)].filter((v) => v !== 0);
    if (!segs.length) continue;
    segs.forEach((v) => present.add(v));
    labelmaps2D[k] = { segmentsOnLabelmap: segs, pixelData, rows: h, columns: w };
  }
  if (!present.size) throw new Error(`“${item.name}” has no masks to export`);
  const metadata: unknown[] = [];
  for (const seg of present) {
    const label = labels[seg - 1];
    const rgb = labelRgb(labels, label).map((v) => v / 255);
    metadata[seg] = {
      SegmentNumber: seg,
      SegmentLabel: label,
      SegmentDescription: `${project.title}: ${label}`,
      SegmentAlgorithmType: "MANUAL",
      RecommendedDisplayCIELabValue: dcmjsData.Colors.rgb2DICOMLAB(rgb),
      SegmentedPropertyCategoryCodeSequence: CATEGORY,
      SegmentedPropertyTypeCodeSequence: { ...TYPE, CodeMeaning: label },
    };
  }
  const labelmap3D = { labelmaps2D, metadata, segmentsOnLabelmap: [...present] };
  // The adapter hands each source image's pixels to dcmjs' normalizer, which assumes 16-bit
  // samples: 8-bit radiographs with an odd pixel count throw. A SEG never uses those pixels,
  // so give it 16-bit copies.
  const segImages = images.map((im) => ({ ...im, voxelManager: { ...im.voxelManager, getScalarData: () => Uint16Array.from(im.getPixelData() as ArrayLike<number>) } }));
  const result = adaptersSEG.Cornerstone3D.Segmentation.generateSegmentation(segImages, labelmap3D, await naturalizedMetadata(imageIds), {
    SeriesDescription: `Inkling masks: ${project.title}`,
  });
  return toBlob(result.dataset);
}

/** Nearest slice of the series to a world point (for 3D measurements). */
function sliceFor(imageIds: string[], p: number[]): string {
  const plane = metaData.get("imagePlaneModule", imageIds[0]);
  const r = plane.rowCosines, c = plane.columnCosines;
  const n = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
  const dot = (a: number[]) => a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
  const target = dot(p);
  let best = imageIds[0], dist = Infinity;
  for (const id of imageIds) {
    const d = Math.abs(dot(metaData.get("imagePlaneModule", id).imagePositionPatient) - target);
    if (d < dist) {
      dist = d;
      best = id;
    }
  }
  return best;
}

/** One TID 1500 SR with a measurement group per length / angle / ROI / probe / arrow. */
export async function buildDicomSr({ project, item, annotations }: Ctx): Promise<Blob> {
  const imageIds = await sourceImageIds(item);
  const is2D = imageIds.length === 1;
  const scheme = adaptersSR.Cornerstone3D.CodeScheme;
  const toolState: Record<string, Record<string, { data: unknown[] }>> = {};
  const add = (toolName: string, a: Annotation, world: Types.Point3[], stats: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const referencedImageId = is2D ? imageIds[0] : sliceFor(imageIds, world[0]);
    const FrameOfReferenceUID = metaData.get("imagePlaneModule", referencedImageId)?.frameOfReferenceUID;
    const text = a.geometry.type === "measurement" && a.geometry.text ? a.geometry.text : a.label;
    const entry = {
      annotationUID: a.id,
      metadata: { toolName, referencedImageId, FrameOfReferenceUID },
      data: {
        handles: { points: world, activeHandleIndex: null, textBox: { hasMoved: false } },
        cachedStats: { [`imageId:${referencedImageId}`]: stats },
        label: text,
        ...extra,
      },
      finding: { CodeValue: scheme.codeValues.CORNERSTONEFREETEXT, CodingSchemeDesignator: scheme.CodingSchemeDesignator, CodeMeaning: text },
    };
    const byTool = (toolState[referencedImageId] ??= {});
    (byTool[toolName] ??= { data: [] }).data.push(entry);
  };
  const toWorld2D = (x: number, y: number) => csUtils.imageToWorldCoords(imageIds[0], [x, y]) as Types.Point3;
  const toWorldIjk = (ijk: number[]) => csUtils.imageToWorldCoords(imageIds[ijk[2]], [ijk[0] + 0.5, ijk[1] + 0.5]) as Types.Point3;

  for (const a of annotations) {
    if (a.itemId !== item.id) continue;
    const g = a.geometry;
    if (g.type === "box") {
      add("RectangleROI", a, [toWorld2D(g.x, g.y), toWorld2D(g.x + g.w, g.y), toWorld2D(g.x, g.y + g.h), toWorld2D(g.x + g.w, g.y + g.h)], {});
    } else if (g.type === "ellipse") {
      add("EllipticalROI", a, [toWorld2D(g.cx, g.cy + g.ry), toWorld2D(g.cx, g.cy - g.ry), toWorld2D(g.cx - g.rx, g.cy), toWorld2D(g.cx + g.rx, g.cy)], {});
    } else if (g.type === "polygon") {
      const poly = g.points.map(([x, y]) => toWorld2D(x, y));
      add("PlanarFreehandROI", a, [], {}, { contour: { polyline: poly, closed: true } });
    } else if (g.type === "keypoint") {
      add("Probe", a, [toWorld2D(g.x, g.y)], {});
    } else if (g.type === "point") {
      add("Probe", a, [toWorldIjk(g.ijk)], {});
    } else if (g.type === "measurement") {
      const world = g.points.map((p) => (g.space === "image" ? toWorld2D(p[0], p[1]) : ([p[0], p[1], p[2]] as Types.Point3)));
      const toolName = KIND_TOOL[g.kind];
      const stats = { ...(g.stats ?? {}), unit: g.unit, areaUnit: g.unit ? `${g.unit}²` : undefined };
      if (g.kind === "freehand-roi") add(toolName, a, [], stats, { contour: { polyline: world, closed: true } });
      else add(toolName, a, world, stats);
    }
  }
  if (!Object.keys(toolState).length) throw new Error(`“${item.name}” has no measurements to export`);
  const report = adaptersSR.Cornerstone3D.MeasurementReport.generateReport(toolState, await naturalizedMetadata(imageIds), {
    SeriesDescription: `Inkling measurements: ${project.title}`,
  });
  return toBlob(report.dataset);
}
