import { labelNames } from "@/platform/environment";
import type { Annotation, Project, StudioItem } from "@/types";
import type { Exporter } from "@/viewers/ViewerAdapter";
import {
  cellLabelMap,
  computeMetrics,
  groupCells,
  isContour,
  mosteller,
  perimeterMm,
  ring,
  resolvePhases,
  STRUCT_KEYS,
  STRUCT_SHORT,
  structures,
  myoArea,
  ringArea,
  cellKey,
  type Grid,
} from "./model";
import { fetchBodySize, fetchHeader, gzip, writeLabelNifti } from "@/kits/io/niftiIO";

const cinePath = (item: StudioItem) => item.assets.find((a) => a.role === "cine")?.path;

/** The (first) item that has cine data and annotations; cine projects have one study per item. */
function pickItem(items: StudioItem[], annotations: Annotation[]): StudioItem {
  const withCine = items.filter((i) => cinePath(i));
  if (!withCine.length) throw new Error("No cine asset in this project");
  return withCine.find((i) => annotations.some((a) => a.itemId === i.id)) ?? withCine[0];
}

async function gridFor(item: StudioItem) {
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

const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !isFinite(v) ? "" : v.toFixed(d));

export const cineExporters: Exporter[] = [
  {
    id: "acdc-nifti",
    label: "ACDC labelmap (NIfTI)",
    description: "4D uint8 .nii.gz, 1 = RV, 2 = MYO, 3 = LV, on the cine's grid and orientation. Frames without contours are zero.",
    filename: (p: Project) => `${p.id}_labels.nii.gz`,
    build: async ({ project, items, annotations }) => {
      const item = pickItem(items, annotations);
      const { header, grid } = await gridFor(item);
      const labels = labelNames(project.labels);
      const n = grid.nx * grid.ny;
      const data = new Uint8Array(n * grid.nz * grid.frames);
      const cells = groupCells(annotations, item.id);
      for (const [key, cell] of cells) {
        const [z, f] = key.split(":").map(Number);
        if (z >= grid.nz || f >= grid.frames) continue;
        cellLabelMap(cell, labels, grid.nx, grid.ny, data.subarray((f * grid.nz + z) * n, (f * grid.nz + z + 1) * n));
      }
      const nii = writeLabelNifti(header, [grid.nx, grid.ny, grid.nz, grid.frames], data, "Inkling cine labels 1=RV 2=MYO 3=LV");
      return gzip(nii);
    },
  },
  {
    id: "cine-metrics-csv",
    label: "Cardiac function (CSV)",
    description: "Per-frame, per-slice RV/MYO/LV areas and volumes, plus EDV, ESV, SV, EF and LV mass (Simpson's method of discs).",
    filename: (p: Project) => `${p.id}_function.csv`,
    build: async ({ project, items, annotations }) => {
      const item = pickItem(items, annotations);
      const { grid } = await gridFor(item);
      const labels = labelNames(project.labels);
      const { ed, es } = resolvePhases(annotations, item.id, item.assets, project.meta);
      const body = await fetchBodySize(cinePath(item)!, project.meta);
      const bsa = mosteller(body.height, body.weight);
      const m = computeMetrics({ annotations, itemId: item.id, labels, grid, ed: ed?.frame ?? null, es: es?.frame ?? null, bsa });
      const rows: string[] = ["section,item,frame,phase,slice,rv_area_mm2,myo_area_mm2,lv_area_mm2"];
      const phaseOf = (f: number) => (f === m.ed ? "ED" : f === m.es ? "ES" : "");
      for (const fm of m.frames) {
        for (const [z, a] of [...fm.areas.entries()].sort((x, y) => x[0] - y[0]))
          rows.push(["area", item.id, fm.frame + 1, phaseOf(fm.frame), z + 1, fmt(a.rv), fmt(a.myo), fmt(a.lv)].join(","));
      }
      rows.push("", "section,item,frame,phase,rv_volume_ml,myo_volume_ml,lv_volume_ml,rv_status,myo_status,lv_status");
      for (const fm of m.frames) {
        if (STRUCT_KEYS.every((k) => fm.volume[k] === null)) continue;
        rows.push(["volume", item.id, fm.frame + 1, phaseOf(fm.frame), fmt(fm.volume.rv), fmt(fm.volume.myo), fmt(fm.volume.lv), fm.status.rv, fm.status.myo, fm.status.lv].join(","));
      }
      const idx = (v: number | null) => (v !== null && bsa ? v / bsa : null);
      rows.push(
        "",
        "metric,value,unit",
        `ED frame,${m.ed !== null ? m.ed + 1 : ""},`,
        `ES frame,${m.es !== null ? m.es + 1 : ""},`,
        `slice spacing,${fmt(grid.spacing[2])},mm`,
        `pixel spacing,${fmt(grid.spacing[0], 4)}x${fmt(grid.spacing[1], 4)},mm`,
        `height,${fmt(body.height, 1)},cm`,
        `weight,${fmt(body.weight, 1)},kg`,
        `BSA (Mosteller),${fmt(bsa, 3)},m2`,
      );
      for (const [k, f] of [["LV", m.lv], ["RV", m.rv]] as const) {
        rows.push(`${k} EDV,${fmt(f.edv)},mL`, `${k} ESV,${fmt(f.esv)},mL`, `${k} SV,${fmt(f.sv)},mL`, `${k} EF,${fmt(f.ef, 1)},%`);
        rows.push(`${k} EDVi,${fmt(idx(f.edv))},mL/m2`, `${k} ESVi,${fmt(idx(f.esv))},mL/m2`);
      }
      rows.push(`LV mass (ED),${fmt(m.mass)},g`, `LV mass index,${fmt(idx(m.mass))},g/m2`);
      for (const w of m.warnings) rows.push(`warning,"${w.replace(/"/g, "'")}",`);
      return new Blob([rows.join("\n") + "\n"], { type: "text/csv" });
    },
  },
  {
    id: "cine-contours-json",
    label: "Contours (JSON)",
    description: "Every contour with its spline control points, densely sampled outline, slice, frame, area and source.",
    filename: (p: Project) => `${p.id}_contours.json`,
    build: async ({ project, items, annotations }) => {
      const item = pickItem(items, annotations);
      const { grid } = await gridFor(item);
      const labels = labelNames(project.labels);
      const s = structures(labels);
      const cells = groupCells(annotations, item.id);
      const { ed, es } = resolvePhases(annotations, item.id, item.assets, project.meta);
      const px = grid.spacing[0] * grid.spacing[1];
      const contours = annotations.filter(isContour).filter((a) => a.itemId === item.id).map((a) => {
        const g = a.geometry;
        const lvs = (cells.get(cellKey(g.slice!, g.frame!))?.contours ?? []).filter((c) => c.label === s.lv).map((c) => c.geometry);
        const myo = a.label === s.myo ? myoArea(g, lvs) : null;
        return {
          id: a.id,
          label: a.label,
          role: myo?.epicardial ? "epicardium" : a.label === s.lv ? "lv-endocardium" : a.label === s.rv ? "rv-endocardium" : "region",
          slice: g.slice,
          frame: g.frame,
          type: g.type,
          controlPoints: g.points,
          points: ring(g).map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]),
          areaMm2: +(ringArea(g) * px).toFixed(2),
          regionAreaMm2: myo ? +(myo.area * px).toFixed(2) : undefined,
          perimeterMm: +perimeterMm(g, grid.spacing[0], grid.spacing[1]).toFixed(2),
          provenance: a.provenance,
          source: a.attributes?.source ?? "manual",
          author: a.author,
        };
      });
      const doc = {
        project: project.id,
        item: item.id,
        coordinates: "voxel (i, j) of the slice; pixel (i, j) spans [i, i+1) × [j, j+1); slice and frame are 0-based",
        grid: { nx: grid.nx, ny: grid.ny, slices: grid.nz, frames: grid.frames, spacingMm: grid.spacing },
        phases: { ED: ed?.frame ?? null, ES: es?.frame ?? null },
        spline: "closed centripetal Catmull-Rom (alpha 0.5) through controlPoints",
        myocardiumRule: "a myocardium contour that encloses an LV contour on the same slice/frame is the epicardium; myocardium = epicardium − LV",
        structures: Object.fromEntries(STRUCT_KEYS.map((k) => [STRUCT_SHORT[k], s[k]])),
        contours,
      };
      return new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    },
  },
];
