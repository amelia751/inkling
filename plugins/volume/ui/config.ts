import * as z from "zod";
import type { Plane } from "@studio/plugin-contracts/types";

/**
 * Viewport layouts of the MPR renderer and its config schema. Pure (no Cornerstone), so
 * the manifest and tests can import it.
 *
 *   mpr     1×3: axial | sagittal | coronal (default)
 *   main    1 + 2: axial large, sagittal and coronal stacked beside it
 *   single  one plane (`plane` picks which)
 *   mpr3d   2×2: the three planes plus a 3D volume render
 *   plane3d 1 + 3D: one plane beside the 3D render
 */
export const PLANES: Plane[] = ["axial", "sagittal", "coronal"];
export const LAYOUT_IDS = ["mpr", "main", "single", "mpr3d", "plane3d"] as const;
export type Layout = (typeof LAYOUT_IDS)[number];
export type Cell = Plane | "3d";

export const LAYOUT_LABELS: Record<Layout, string> = {
  mpr: "1×3 MPR",
  main: "1 + 2",
  single: "Single plane",
  mpr3d: "MPR + 3D",
  plane3d: "1 + 3D",
};

/** Cells a layout shows, in grid order. */
export function cellsFor(layout: Layout, single: Plane): Cell[] {
  if (layout === "single") return [single];
  if (layout === "plane3d") return [single, "3d"];
  if (layout === "mpr3d") return ["axial", "sagittal", "coronal", "3d"];
  return ["axial", "sagittal", "coronal"];
}

/** Whether a layout uses the plane picker (one plane on its own or beside the 3D render). */
export const usesPlanePicker = (layout: Layout) => layout === "single" || layout === "plane3d";

/** Tailwind grid template of a layout. */
export function gridClass(layout: Layout): string {
  switch (layout) {
    case "mpr":
      return "grid-cols-3 grid-rows-1";
    case "main":
      return "grid-cols-[2fr_1fr] grid-rows-2";
    case "mpr3d":
      return "grid-cols-2 grid-rows-2";
    case "plane3d":
      return "grid-cols-2 grid-rows-1";
    default:
      return "grid-cols-1 grid-rows-1";
  }
}

const layoutEnum = z.enum(LAYOUT_IDS);

export const mprConfigSchema = z.object({
  layout: layoutEnum.default("mpr").describe("Initial layout: mpr (1×3), main (1 + 2), single, mpr3d (2×2 with 3D), plane3d (1 + 3D)"),
  layouts: z.array(layoutEnum).min(1).default(["mpr", "main", "single", "mpr3d"]).describe("Layouts offered in the viewport bar's Layout picker, in order"),
  plane: z.enum(["axial", "sagittal", "coronal"]).default("axial").describe("Plane shown by the single and plane3d layouts"),
  sequence: z.string().default("flair").describe("Sequence opened first when the subject has it (else the first one)"),
  preset3d: z.string().default("MR-Default").describe("Cornerstone volume-rendering preset of the 3D cell"),
});
export type MprConfig = z.infer<typeof mprConfigSchema>;

/** Config with defaults filled in, tolerant of partial or invalid input. */
export function mprConfig(config: Record<string, unknown> | undefined): MprConfig {
  const r = mprConfigSchema.safeParse(config ?? {});
  return r.success ? r.data : mprConfigSchema.parse({});
}
