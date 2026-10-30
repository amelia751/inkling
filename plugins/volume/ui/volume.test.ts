import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { describeGeometry } from "@/extension-host/describe";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment } from "@/extension-host/resolve";
import { migrateAnnotation } from "@studio/plugin-contracts/migrations/annotations-v1-to-v2";
import type { Annotation, Project, StudioItem } from "@studio/plugin-contracts/types";
import { cellsFor, gridClass, mprConfig, mprConfigSchema } from "./config";
import { groupItems, initialSource, referenceAsset, volumeSources } from "./dataKind";
import { labelmapNifti, masksJsonDocument } from "./exporters";
import { describeLandmark, point3dSchema } from "./geometries";
import { labelIndexForValue, labelValue } from "./labelValues";
import { ns } from "@studio/plugin-contracts/naming";

const asset = (path: string, extra: Record<string, string> = {}) => ({ path, sha256: "", bytes: 0, ...extra });
const brats = {
  id: "3d-brain-mri",
  title: "BraTS 2021",
  source: "brats",
  labels: [{ name: "labels", control: "BrushLabels", classes: [{ id: "necrotic core" }, { id: "edema" }, { id: "enhancing tumor" }] }],
  assets: [
    asset("s1/flair.nii.gz", { subject: "S1", sequence: "flair" }),
    asset("s1/t1ce.nii.gz", { subject: "S1", sequence: "t1ce" }),
    asset("s1/seg.nii.gz", { subject: "S1", sequence: "seg" }),
    asset("s2/t1.nii.gz", { subject: "S2", sequence: "t1" }),
  ],
} as unknown as Project;

describe("volume data kind", () => {
  it("groups assets by subject and splits sequences / DICOM series", () => {
    const items = groupItems(brats);
    expect(items.map((i) => [i.id, i.assets.length, i.dataKind])).toEqual([
      ["S1", 3, ns("volume.dataKinds.volume")],
      ["S2", 1, ns("volume.dataKinds.volume")],
    ]);
    const src = volumeSources(items[0].assets);
    expect(src.map((s) => [s.key, s.kind, s.paths.length])).toEqual([
      ["flair", "nifti", 1],
      ["t1ce", "nifti", 1],
    ]);
    expect(referenceAsset(items[0].assets)?.path).toBe("s1/seg.nii.gz");
    const dicom = volumeSources([asset("ct/IM1.dcm"), asset("ct/IM2.DCM"), asset("x/scan.nii")]);
    expect(dicom.map((s) => [s.key, s.label, s.kind, s.paths.length])).toEqual([
      ["series", "Series", "dicom", 2],
      ["x/scan.nii", "scan.nii", "nifti", 1],
    ]);
    expect(initialSource(src, "t1ce")?.key).toBe("t1ce");
    expect(initialSource(src, "nope")?.key).toBe("flair");
  });
});

describe("MPR config", () => {
  it("defaults to today's 1×3 layout and the four classic layouts", () => {
    expect(mprConfigSchema.parse({})).toEqual({ layout: "mpr", layouts: ["mpr", "main", "single", "mpr3d"], plane: "axial", sequence: "flair", preset3d: "MR-Default" });
    expect(mprConfig({ layout: "bogus" }).layout).toBe("mpr");
  });

  it("maps layouts to cells and grids", () => {
    expect(cellsFor("mpr", "axial")).toEqual(["axial", "sagittal", "coronal"]);
    expect(cellsFor("main", "axial")).toEqual(["axial", "sagittal", "coronal"]);
    expect(cellsFor("single", "coronal")).toEqual(["coronal"]);
    expect(cellsFor("mpr3d", "axial")).toEqual(["axial", "sagittal", "coronal", "3d"]);
    expect(cellsFor("plane3d", "sagittal")).toEqual(["sagittal", "3d"]);
    expect(gridClass("mpr3d")).toBe("grid-cols-2 grid-rows-2");
  });

  it("resolves the preset with the renderer's defaults and its commands", () => {
    const r = resolveEnvironment({ extends: "preset:volume-3d" }, registry);
    expect(r.errors).toBeUndefined();
    expect(r.env!.viewports[0].config).toMatchObject({ layout: "mpr", plane: "axial" });
    const ids = r.env!.commands.map((c) => c.id);
    for (const id of [
      ns("volume.commands.stepSlice"),
      ns("volume.commands.firstLastSlice"),
      ns("volume.commands.fitView"),
      ns("volume.commands.cancelManipulation"),
      ns("volume.commands.interpolateSlices"),
      ns("cornerstone.commands.invertImage"),
      ns("cornerstone.commands.rotateViewLeft"),
      ns("core.commands.rotateView"),
      ns("core.commands.holdToPan"),
    ])
      expect(ids).toContain(id);
    // ↑/↓ step slices, not items; PageUp/PageDown still change item.
    const prev = r.env!.commands.find((c) => c.id === ns("core.commands.prevItem"))!;
    expect(prev.keys).toEqual(["ArrowLeft", "PageUp"]);
  });

  it("rejects an unknown layout in the environment", () => {
    const r = resolveEnvironment({ extends: "preset:volume-3d", viewports: [{ name: "main", renderer: ns("volume.renderers.cornerstone-mpr"), config: { layout: "4x4" } }] }, registry);
    expect(r.errors?.length).toBeGreaterThan(0);
  });
});

describe("point3d landmarks", () => {
  const v1 = { id: "p", itemId: "S1", label: "edema", geometry: { type: "point", plane: "axial", slice: 77, ijk: [110, 130, 77] } } as unknown as Annotation;

  it("migrates v1 points and describes them", () => {
    const a = migrateAnnotation(v1);
    expect(a.geometry).toEqual({ type: "point3d", plane: "axial", slice: 77, ijk: [110, 130, 77] });
    expect(point3dSchema.safeParse(a.geometry).success).toBe(true);
    expect(describeLandmark(a.geometry as never)).toBe("Point · axial 78 · voxel 110, 130, 77");
    expect(describeGeometry(a)).toBe("Point · axial 78 · voxel 110, 130, 77");
    expect(point3dSchema.safeParse({ type: "point3d", plane: "oblique", slice: 1, ijk: [1, 2, 3] }).success).toBe(false);
  });
});

describe("exporters", () => {
  it("uses BraTS voxel values for BraTS projects, index + 1 otherwise", () => {
    expect(["necrotic core", "edema", "enhancing tumor", "x"].map((l) => labelValue(brats, l))).toEqual([1, 2, 4, 0]);
    expect([1, 2, 4, 3, 0].map((v) => labelIndexForValue(brats, v))).toEqual([0, 1, 2, -1, -1]);
    const other = { ...brats, id: "ct", title: "CT", source: "synthetic" } as Project;
    expect(["necrotic core", "edema", "enhancing tumor"].map((l) => labelValue(other, l))).toEqual([1, 2, 3]);
  });

  const item = { id: "S1", name: "S1", group: "Subjects", assets: brats.assets.slice(0, 3) } as StudioItem;
  // 2×2×2 grid; "edema" on voxels 1 and 6, "enhancing tumor" on 7.
  const masks = [
    { id: "m1", itemId: "S1", label: "edema", provenance: "human-created", attributes: { source: "reference" }, geometry: { type: "mask", dims: [2, 2, 2], counts: [1, 1, 4, 1, 1], voxels: 2, volumeMm3: 2 } },
    { id: "m2", itemId: "S1", label: "enhancing tumor", provenance: "human-created", geometry: { type: "mask", dims: [2, 2, 2], counts: [7, 1], voxels: 1, volumeMm3: 1 } },
    { id: "k", itemId: "S1", label: "edema", geometry: { type: "point3d", plane: "axial", slice: 0, ijk: [0, 0, 0] } },
  ] as unknown as Annotation[];

  it("writes a uint8 NIfTI labelmap on the source header", () => {
    const bytes = new Uint8Array(348);
    const out = labelmapNifti({ bytes, littleEndian: true, dims: [2, 2, 2] }, brats, item, masks);
    const dv = new DataView(out.buffer);
    expect(out.length).toBe(352 + 8);
    expect([dv.getInt32(0, true), dv.getInt16(40, true), dv.getInt16(70, true), dv.getInt16(72, true), dv.getFloat32(108, true), dv.getFloat32(124, true)]).toEqual([348, 3, 2, 8, 352, 4]);
    expect([...out.slice(344, 348)]).toEqual([0x6e, 0x2b, 0x31, 0x00]);
    expect([...out.slice(352)]).toEqual([0, 2, 0, 0, 0, 0, 2, 4]);
  });

  it("builds the masks JSON document from mask annotations only", () => {
    const doc = masksJsonDocument({ project: brats, items: [item], annotations: masks });
    expect(JSON.stringify(doc)).toBe(
      JSON.stringify({
        project: "3d-brain-mri",
        encoding: "RLE over flattened grid, x fastest then y then z; counts alternate background/foreground starting with background",
        labels: [
          { name: "necrotic core", value: 1 },
          { name: "edema", value: 2 },
          { name: "enhancing tumor", value: 4 },
        ],
        subjects: [
          {
            subject: "S1",
            masks: [
              { id: "m1", label: "edema", value: 2, dims: [2, 2, 2], counts: [1, 1, 4, 1, 1], voxels: 2, volume_mm3: 2, provenance: "human-created", source: "reference" },
              { id: "m2", label: "enhancing tumor", value: 4, dims: [2, 2, 2], counts: [7, 1], voxels: 1, volume_mm3: 1, provenance: "human-created" },
            ],
          },
        ],
      }),
    );
  });
});
