import * as nifti from "nifti-reader-js";
import { seedUrl } from "@/lib/api";
import { useStudio } from "@/stores/studio";
import type { Annotation, Project, StudioItem } from "@/types";
import type { Exporter } from "@/viewers/ViewerAdapter";
import { decodeMaskInto } from "@/viewers/cornerstone/rle";

/** BraTS label convention: necrotic core 1, edema 2, enhancing tumor 4. */
export function isBrats(project: Project): boolean {
  return /brats/i.test(`${project.id} ${project.title} ${project.source}`) && (project.labels?.length ?? 0) === 3;
}

/** Voxel value written for a label (and read from a reference segmentation). */
export function labelValue(project: Project, label: string): number {
  const i = (project.labels ?? []).indexOf(label);
  if (i < 0) return 0;
  return isBrats(project) ? [1, 2, 4][i] : i + 1;
}

/** Label index for a voxel value of a reference segmentation, or -1. */
export function labelIndexForValue(project: Project, value: number): number {
  if (!value) return -1;
  if (isBrats(project)) return [1, 2, 4].indexOf(value);
  const i = value - 1;
  return i < (project.labels?.length ?? 0) ? i : -1;
}

function headerSource(item: StudioItem) {
  return item.assets.find((a) => a.sequence === "seg") ?? item.assets.find((a) => a.sequence === "flair") ?? item.assets[0];
}

async function readHeaderBytes(path: string): Promise<{ bytes: Uint8Array; littleEndian: boolean; dims: number[] }> {
  const res = await fetch(seedUrl(path));
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
  const { bytes, littleEndian, dims } = await readHeaderBytes(src.path);
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
  dv.setFloat32(124, Math.max(...(project.labels ?? []).map((l) => labelValue(project, l)), 1), littleEndian); // cal_max
  dv.setFloat32(128, 0, littleEndian); // cal_min
  out.set([0x6e, 0x2b, 0x31, 0x00], 344); // magic "n+1"
  // Bytes 348–351: no extensions.
  out.set(labelmap, 352);
  return out;
}

export const niftiCurrentExporter: Exporter = {
  id: "nifti-labelmap",
  label: "NIfTI labelmap (current subject)",
  description:
    "One .nii.gz labelmap of the subject open in the studio; geometry copied from its own scan. BraTS values 1/2/4, otherwise label index + 1.",
  filename: (project) => {
    const s = useStudio.getState();
    return `${project.id}-${s.projectId === project.id ? "subject" : "labels"}-${s.itemIndex + 1}.nii.gz`;
  },
  async build({ project, items, annotations }) {
    const item = items[Math.min(items.length - 1, useStudio.getState().itemIndex)] ?? items[0];
    if (!item) throw new Error("No subjects to export");
    return gzip(await buildSubjectNifti(project, item, annotations));
  },
};

export const masksJsonExporter: Exporter = {
  id: "masks-json",
  label: "Masks JSON (all subjects)",
  description:
    "Every subject's masks as run-length encoded voxel grids (x fastest, background first) with label values, voxel counts and volumes.",
  filename: (project) => `${project.id}-masks.json`,
  async build({ project, items, annotations }) {
    const labels = project.labels ?? [];
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
    const doc = {
      project: project.id,
      encoding: "RLE over flattened grid, x fastest then y then z; counts alternate background/foreground starting with background",
      labels: labels.map((l) => ({ name: l, value: labelValue(project, l) })),
      subjects,
    };
    return new Blob([JSON.stringify(doc)], { type: "application/json" });
  },
};
