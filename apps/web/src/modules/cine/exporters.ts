import { gzip, writeLabelNifti } from "@/kits/io/niftiIO";
import { labelNames } from "@/platform/environment";
import type { ExporterImpl } from "@/platform/module";
import type { Project } from "@/types";
import { cineGridFor, pickCineItem } from "./io";
import { cellKey, cellLabelMap, groupCells, isContour, myoArea, perimeterMm, resolvePhases, ring, ringArea, STRUCT_KEYS, STRUCT_SHORT, structureOf } from "./model";
import { cineConfigFor, structuresOf } from "./public";
import { NAMING } from "@studio/plugin-contracts/naming";

/** Label map (NIfTI) and contours (JSON). The cardiac function CSV lives in inkling.cardiac-metrics. */
export const cineExporters: Record<string, ExporterImpl> = {
  "acdc-nifti": {
    filename: (p: Project) => `${p.id}_labels.nii.gz`,
    build: async ({ project, items, annotations, env }) => {
      const item = pickCineItem(items, annotations);
      const { header, grid } = await cineGridFor(item);
      const labels = labelNames(project.labels);
      const s = structuresOf(cineConfigFor(env, project));
      const n = grid.nx * grid.ny;
      const data = new Uint8Array(n * grid.nz * grid.frames);
      const cells = groupCells(annotations, item.id);
      for (const [key, cell] of cells) {
        const [z, f] = key.split(":").map(Number);
        if (z >= grid.nz || f >= grid.frames) continue;
        cellLabelMap(cell, labels, s, grid.nx, grid.ny, data.subarray((f * grid.nz + z) * n, (f * grid.nz + z + 1) * n));
      }
      // "1=RV 2=MYO 3=LV" for the seed labels: value = label position, named by structure role.
      const legend = labels.map((l, i) => `${i + 1}=${structureOf(s, l) ? STRUCT_SHORT[structureOf(s, l)!] : l}`).join(" ");
      const nii = writeLabelNifti(header, [grid.nx, grid.ny, grid.nz, grid.frames], data, `${NAMING.displayName} cine labels ${legend}`);
      return gzip(nii);
    },
  },
  "cine-contours-json": {
    filename: (p: Project) => `${p.id}_contours.json`,
    build: async ({ project, items, annotations, env }) => {
      const item = pickCineItem(items, annotations);
      const { grid } = await cineGridFor(item);
      const config = cineConfigFor(env, project);
      const s = structuresOf(config);
      const cells = groupCells(annotations, item.id);
      const phases = resolvePhases(annotations, item.id, item.assets, project.meta, config.keyFrames.map((k) => k.id));
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
        phases: Object.fromEntries(Object.entries(phases).map(([id, m]) => [id, m?.frame ?? null])),
        spline: "closed centripetal Catmull-Rom (alpha 0.5) through controlPoints",
        myocardiumRule: "a myocardium contour that encloses an LV contour on the same slice/frame is the epicardium; myocardium = epicardium − LV",
        structures: Object.fromEntries(STRUCT_KEYS.map((k) => [STRUCT_SHORT[k], s[k]])),
        contours,
      };
      return new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    },
  },
};
