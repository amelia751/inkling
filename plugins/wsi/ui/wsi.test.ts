import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { migrateDocument } from "@studio/plugin-contracts/migrations/annotations-v1-to-v2";
import { describeGeometry } from "@/extension-host/describe";
import type { InspectFn } from "@studio/plugin-ui-sdk/module";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment } from "@/extension-host/resolve";
import type { Annotation, Geometry, Project, StudioItem } from "@studio/plugin-contracts/types";
import { fromGeoJSON, toAsapXml, toCountsCsv, toQuPathGeoJSON } from "./io";
import { countPoints, inspectRows } from "./measure";
import { ns } from "@studio/plugin-contracts/naming";

const project = { id: "p", labels: ["tumor", "stroma", "lymphocytes"], assets: [] } as unknown as Project;
const item: StudioItem = { id: "s1", name: "slide", group: "Slides", assets: [{ path: "s1.dzi", slide: "TCGA-1", mpp: 0.25 } as StudioItem["assets"][number]], dataKind: ns("wsi.dataKinds.raster-pyramid") };
const ann = (id: string, geometry: Geometry, label = "tumor"): Annotation => ({ id, itemId: "s1", label, geometry, provenance: "human-created", author: "t", createdAt: "" });
const square: Geometry = { type: "polygon", points: [[0, 0], [100, 0], [100, 100], [0, 100]] };

describe("wsi: mark → keypoint", () => {
  // v1 documents store `mark`; they load as keypoints (lib/api MIGRATED_V1_TYPES) and export as points did.
  const v1 = { revision: 1, annotations: [ann("r", square), ...[10, 20, 30].map((x, i) => ann(`m${i}`, { type: "mark", x, y: 10 } as Geometry)), ann("l", { type: "mark", x: 50, y: 50 } as Geometry, "lymphocytes")] };
  const { annotations } = migrateDocument(v1, new Set(["mark"]));

  it("migrates to keypoints with no attributes", () => {
    expect(annotations.slice(1).map((a) => a.geometry)).toEqual([{ type: "keypoint", x: 10, y: 10 }, { type: "keypoint", x: 20, y: 10 }, { type: "keypoint", x: 30, y: 10 }, { type: "keypoint", x: 50, y: 50 }]);
    expect(annotations[1].attributes).toBeUndefined();
  });

  it("QuPath GeoJSON: per-class MultiPoint / Point features, as for v1 marks", () => {
    const fc = toQuPathGeoJSON(project, [item], annotations);
    const pts = fc.features.filter((f) => f.geometry?.type.endsWith("Point")).map((f) => ({ ...f, id: "x" }));
    expect(pts).toEqual([
      { type: "Feature", id: "x", geometry: { type: "MultiPoint", coordinates: [[10, 10], [20, 10], [30, 10]] }, properties: { objectType: "annotation", classification: { name: "tumor", color: expect.any(Array) }, isLocked: false, measurements: { "Num points": 3 }, metadata: { inkling_item: "TCGA-1" } } },
      { type: "Feature", id: "x", geometry: { type: "Point", coordinates: [50, 50] }, properties: { objectType: "annotation", classification: { name: "lymphocytes", color: expect.any(Array) }, isLocked: false, measurements: { "Num points": 1 }, metadata: { inkling_item: "TCGA-1" } } },
    ]);
  });

  it("ASAP XML: PointSet / Dot per class; counts CSV: points per class and density", () => {
    const xml = toAsapXml(project, [item], annotations);
    expect(xml).toContain('Type="PointSet" PartOfGroup="tumor"');
    expect(xml).toContain('Type="Dot" PartOfGroup="lymphocytes"');
    const csv = toCountsCsv(project, [item], annotations).trim().split("\n");
    expect(csv[0]).toBe("slide,class,points,regions,region_area,area_unit,points_per_mm2");
    expect(csv[1]).toBe(`"TCGA-1","tumor",3,1,625.0,um2,${(3 / (625 * 1e-6)).toFixed(1)}`);
    expect(csv[3]).toBe(`"TCGA-1","lymphocytes",1,0,0.0,um2,`);
  });

  it("GeoJSON import creates keypoints", () => {
    const { annotations: imported, skipped } = fromGeoJSON(JSON.stringify({ type: "Feature", geometry: { type: "MultiPoint", coordinates: [[1, 2], [3, 4]] }, properties: { classification: { name: "Stroma" } } }), "s1", ["tumor", "stroma"], "tumor");
    expect(skipped).toBe(0);
    expect(imported.map((a) => [a.label, a.geometry])).toEqual([["stroma", { type: "keypoint", x: 1, y: 2 }], ["stroma", { type: "keypoint", x: 3, y: 4 }]]);
  });

  it("counts points inside a region", () => {
    expect(countPoints(annotations, "s1", [[square.type === "polygon" ? square.points : []]])).toEqual(new Map([["tumor", 3], ["lymphocytes", 1]]));
    expect(countPoints(annotations, "s1", [[[[0, 0], [15, 0], [15, 15], [0, 15]]]])).toEqual(new Map([["tumor", 1]]));
  });
});

describe("wsi module", () => {
  it("the pathology preset resolves with the counts and adjust panels", () => {
    const res = resolveEnvironment({ extends: "preset:pathology" }, registry, { baseModules: [ns("core")] });
    expect(res.errors).toBeUndefined();
    const env = res.env!;
    expect(env.panels.right.map((p) => p.id)).toContain(ns("wsi.panels.counts"));
    expect(env.panels["viewport-bar"].map((p) => p.id)).toEqual([ns("wsi.panels.adjust")]);
    expect(env.commands.map((c) => c.id)).toEqual(expect.arrayContaining([ns("wsi.commands.toggleClassNames"), ns("wsi.commands.importGeoJSON"), ns("core.commands.rotateView"), ns("core.commands.holdToPan")]));
    expect(env.viewports[0].config).toEqual({ showNavigator: true });
    expect(describeGeometry(ann("k", { type: "keypoint", x: 12.4, y: 7.6 }), env)).toBe("Point · 12, 8");
  });

  it("resolves the README environment", () => {
    const res = resolveEnvironment(
      {
        data: { kind: ns("wsi.dataKinds.raster-pyramid") },
        viewports: [{ name: "main", renderer: ns("wsi.renderers.osd"), config: { mpp: 0.25 } }],
        tools: [ns("core.tools.select"), ns("core.tools.pan"), ns("overlay2d.tools.polygon"), ns("wsi.tools.brush"), ns("wsi.tools.wand"), ns("wsi.tools.mark")],
        panels: { left: [ns("core.panels.files"), ns("core.panels.labels")], right: [ns("wsi.panels.counts")], "viewport-bar": [ns("wsi.panels.adjust")] },
        exporters: [ns("wsi.exporters.qupath-geojson"), ns("wsi.exporters.point-counts-csv")],
        labels: [{ name: "tissue", control: "PolygonLabels", classes: [{ id: "tumor" }, { id: "stroma" }] }],
      },
      registry,
      { baseModules: [ns("core")] },
    );
    expect(res.errors).toBeUndefined();
    expect(res.env!.viewports[0].config).toEqual({ mpp: 0.25, showNavigator: true });
  });

  it("the inspector reads mpp from the runtime", async () => {
    const inspect = await registry.loadImpl<InspectFn>(ns("wsi.inspectors.main"));
    const rows = (mpp: number | undefined) => Object.fromEntries(inspect!(ann("r", square), { env: null as never, project, item, runtime: { publish: () => {}, get: <T,>(k: string) => (k === "mpp" ? (mpp as T) : undefined) } }));
    expect(rows(0.5).Area).toBe("2,500 µm²");
    expect(rows(undefined)).toMatchObject({ Area: "10,000 px²", Scale: "µm/px unknown" });
    expect(inspectRows(ann("k", { type: "keypoint", x: 1234.4, y: 5 }), 0.5, [])).toContainEqual(["Position", "1,234, 5 px"]);
  });
});
