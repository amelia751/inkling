import { fetchHeader } from "@/kits/io/niftiIO";
import type { Annotation, StudioItem } from "@/types";
import type { Grid } from "./model";

/** Exporter helpers shared with modules built on the cine (through public.ts). */

export const cinePath = (item: StudioItem) => item.assets.find((a) => a.role === "cine")?.path;

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
