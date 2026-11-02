import { fetchHeader } from "@studio/renderers/io/niftiIO";
import type { Annotation, StudioItem } from "@studio/contracts/types";
import type { Grid } from "./model";

/** Exporter helpers shared with modules built on the cine (through public.ts). */

const NIFTI = /\.nii(\.gz)?$/i;
const REFERENCE_NAME = /_(gt|seg)\.nii(\.gz)?$/i;

/**
 * The item's cine series: the asset tagged `role: "cine"` (seeds), else, for uploads that carry
 * no role, a NIfTI with frames, else the first NIfTI that isn't a `_gt` / `_seg` reference.
 */
export const cineAsset = (item: StudioItem) =>
  item.assets.find((a) => a.role === "cine") ??
  item.assets.find((a) => NIFTI.test(a.name ?? a.path) && (a.frames ?? 0) > 1) ??
  item.assets.find((a) => NIFTI.test(a.name ?? a.path) && !REFERENCE_NAME.test(a.name ?? a.path) && a.role !== "reference");

export const cinePath = (item: StudioItem) => cineAsset(item)?.path;

/** The (first) item that has cine data and annotations; cine projects have one study per item. */
export function pickCineItem(items: StudioItem[], annotations: Annotation[]): StudioItem {
  const withCine = items.filter((i) => cinePath(i));
  if (!withCine.length) throw new Error("No cine asset in this project");
  return withCine.find((i) => annotations.some((a) => a.itemId === i.id)) ?? withCine[0];
}

/** The cine's NIfTI header and voxel grid (only the header bytes are fetched). */
export async function cineGridFor(item: StudioItem) {
  const header = await fetchHeader(cinePath(item)!);
  const [, nx, ny, nz, nt] = header.dim;
  const grid: Grid = {
    nx,
    ny,
    nz: Math.max(1, nz),
    frames: header.dim[0] >= 4 ? Math.max(1, nt) : 1,
    spacing: [header.pixdim[1] || 1, header.pixdim[2] || 1, header.pixdim[3] || 1],
  };
  return { header, grid };
}
