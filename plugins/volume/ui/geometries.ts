import * as z from "zod";
import type { GeometryContribution } from "@studio/plugin-ui-sdk/module";
import type { Geometry } from "@studio/contracts/types";

/**
 * Volume refinement of core `point3d`: a landmark in voxel indices on the plane it was
 * placed on (`slice` is the voxel index along that plane's axis). Stored v1 `point`s
 * migrate to it on load (migrations/annotations-v1-to-v2.ts).
 */
export const point3dSchema = z.object({
  type: z.literal("point3d"),
  plane: z.enum(["axial", "sagittal", "coronal"]),
  slice: z.number().int().min(0),
  ijk: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)]),
});

type Point3d = Extract<Geometry, { type: "point3d" }>;

export function describeLandmark(g: Point3d): string {
  return `Point · ${g.plane} ${g.slice + 1} · voxel ${g.ijk.join(", ")}`;
}

export const volumeGeometries: GeometryContribution[] = [
  {
    id: "landmark",
    type: "point3d",
    spaces: ["volume"],
    schema: point3dSchema,
    describe: (g) => describeLandmark(g as Point3d),
    description: "3D landmark: voxel indices (i, j, k) plus the plane and slice it was placed on",
  },
];
