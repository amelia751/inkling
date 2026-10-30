import * as nifti from "nifti-reader-js";
import { decodeMaskInto } from "@studio/renderers/cornerstone/rle";
import { labelNames } from "@studio/contracts/environment";
import type { ExportContext, ExporterImpl } from "@studio/plugin-ui-sdk/module";
import type { Annotation, Project, StudioItem } from "@studio/contracts/types";
import { labelValue } from "./labelValues";
import { assetUrl, useHost } from "@studio/plugin-ui-sdk";

/**
 * Volume exporters (ids, labels and descriptions live in the manifest):
 * `nifti-labelmap` (the open subject as a uint8 .nii.gz) and `masks-json` (every subject's
 * RLE masks). Both read only `mask` geometries.
 */

function headerSource(item: StudioItem) {
  return item.assets.find((a) => a.sequence === "seg") ?? item.assets.find((a) => a.sequence === "flair") ?? item.assets[0];
}

async function readHeaderBytes(path: string): Promise<{ bytes: Uint8Array; littleEndian: boolean; dims: number[] }> {
  const res = await fetch(assetUrl(path));
  if (!res.ok) throw new Error(`Could not fetch ${path} (${res.status})`);
  let buf = await res.arrayBuffer();
  if (nifti.isCompressed(buf)) buf = nifti.decompress(buf) as ArrayBuffer;
  if (!nifti.isNIFTI1(buf)) throw new Error(`${path} is not a NIfTI-1 file`);
  const header = nifti.readHeader(buf);
  if (!header) throw new Error(`${path} has an unreadable header`);
  return { bytes: new Uint8Array(buf.slice(0, 348)), littleEndian: header.littleEndian, dims: [header.dims[1], header.dims[2], header.dims[3]] };
}

async function gzip(data: Uint8Array): Promise<Blob> {
  const blob = new Blob([data as BlobPart]);
  if (typeof CompressionStream === "undefined") return blob;
  return new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

/**
 * Build a uint8 NIfTI-1 labelmap for one subject from its mask annotations, copying the
 * geometry (dims, pixdim, qform/sform) from the subject's own segmentation (or FLAIR) header.
 */
export async function buildSubjectNifti(project: Project, item: StudioItem, annotations: Annotation[]): Promise<Uint8Array> {
  const src = headerSource(item);
  if (!src) throw new Error(`${item.name} has no volume to take geometry from`);
  return labelmapNifti(await readHeaderBytes(src.path), project, item, annotations);
}

/** The labelmap file for a source header (348 bytes, its endianness and dims). Pure. */
export function labelmapNifti(
  { bytes, littleEndian, dims }: { bytes: Uint8Array; littleEndian: boolean; dims: number[] },
  project: Project,
  item: StudioItem,
  annotations: Annotation[],
): Uint8Array {
  const n = dims[0] * dims[1] * dims[2];
  const labelmap = new Uint8Array(n);
  for (const a of annotations) {
    if (a.itemId !== item.id || a.geometry.type !== "mask") continue;
    const g = a.geometry;
    if (g.dims.length !== 3 || g.dims[0] * g.dims[1] * g.dims[2] !== n) continue;
    decodeMaskInto(g.counts, labelmap, labelValue(project, a.label));
  }
  const out = new Uint8Array(352 + n);
  out.set(bytes, 0);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, 348, littleEndian);
  dv.setInt16(40, 3, littleEndian); // dim[0]
  dv.setInt16(48, 1, littleEndian); // dim[4]
  dv.setInt16(50, 1, littleEndian);
  dv.setInt16(52, 1, littleEndian);
  dv.setInt16(54, 1, littleEndian);
  dv.setInt16(70, 2, littleEndian); // datatype: NIFTI_TYPE_UINT8
  dv.setInt16(72, 8, littleEndian); // bitpix
  dv.setFloat32(108, 352, littleEndian); // vox_offset
  dv.setFloat32(112, 1, littleEndian); // scl_slope
  dv.setFloat32(116, 0, littleEndian); // scl_inter
  dv.setFloat32(124, Math.max(...labelNames(project.labels).map((l) => labelValue(project, l)), 1), littleEndian); // cal_max
  dv.setFloat32(128, 0, littleEndian); // cal_min
  out.set([0x6e, 0x2b, 0x31, 0x00], 344); // magic "n+1"
  // Bytes 348–351: no extensions.
  out.set(labelmap, 352);
  return out;
}

export const niftiLabelmapExporter: ExporterImpl = {
  filename: (project) => {
    const s = useHost.getState();
    return `${project.id}-${s.projectId === project.id ? "subject" : "labels"}-${s.itemIndex + 1}.nii.gz`;
  },
  async build({ project, items, annotations }) {
    const item = items[Math.min(items.length - 1, useHost.getState().itemIndex)] ?? items[0];
    if (!item) throw new Error("No subjects to export");
    return gzip(await buildSubjectNifti(project, item, annotations));
  },
};

/** The masks JSON document (exported as-is by `masks-json`). */
export function masksJsonDocument({ project, items, annotations }: Pick<ExportContext, "project" | "items" | "annotations">) {
  const labels = labelNames(project.labels);
  const subjects = items.map((item) => ({
    subject: item.id,
    masks: annotations
      .filter((a) => a.itemId === item.id && a.geometry.type === "mask")
      .map((a) => {
        const g = a.geometry as Extract<Annotation["geometry"], { type: "mask" }>;
        return {
          id: a.id,
          label: a.label,
          value: labelValue(project, a.label),
          dims: g.dims,
          counts: g.counts,
          voxels: g.voxels,
          volume_mm3: g.volumeMm3,
          provenance: a.provenance,
          source: a.attributes?.source,
        };
      }),
  }));
  return {
    project: project.id,
    encoding: "RLE over flattened grid, x fastest then y then z; counts alternate background/foreground starting with background",
    labels: labels.map((l) => ({ name: l, value: labelValue(project, l) })),
    subjects,
  };
}

export const masksJsonExporter: ExporterImpl = {
  filename: (project) => `${project.id}-masks.json`,
  async build(ctx) {
    return new Blob([JSON.stringify(masksJsonDocument(ctx))], { type: "application/json" });
  },
};
