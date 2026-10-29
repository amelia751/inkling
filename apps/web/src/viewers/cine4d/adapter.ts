import { labelNames } from "@/platform/environment";
import { useStudio } from "@/stores/studio";
import type { ViewerAdapter } from "@/viewers/ViewerAdapter";
import { Cine4DViewer } from "./Cine4DViewer";
import { cineExporters } from "./exporters";
import { cellKey, groupCells, isContour, isMask, knownGrids, myoArea, perimeterMm, ringArea, structures } from "./model";
import { rleForeground } from "@/kits/overlay2d/geometry";

export const cine4dAdapter: ViewerAdapter = {
  kind: "cine-4d",
  tools: ["select", "pan", "windowLevel", "spline", "polygon", "freehand", "brush", "eraser"],
  Component: Cine4DViewer,
  exporters: cineExporters,
  inspect: (a, { project, item }) => {
    const g = a.geometry;
    const grid = knownGrids.get(item.id);
    const sx = grid?.spacing[0] ?? 1, sy = grid?.spacing[1] ?? 1;
    const unit = grid ? "mm" : "px";
    const rows: [string, string][] = [];
    if (g.type === "phase") {
      return [["Phase", g.phase === "ED" ? "End-diastole" : "End-systole"], ["Frame", String(g.frame + 1)]];
    }
    const s = structures(labelNames(project.labels));
    const role = a.label === s.lv ? "LV endocardium" : a.label === s.rv ? "RV endocardium" : a.label === s.myo ? "Myocardium" : a.label;
    if (isContour(a)) {
      const geo = a.geometry;
      const cell = groupCells(useStudio.getState().annotations, item.id).get(cellKey(geo.slice!, geo.frame!));
      const lvs = (cell?.contours ?? []).filter((c) => c.label === s.lv).map((c) => c.geometry);
      const myo = a.label === s.myo ? myoArea(geo, lvs) : null;
      rows.push(["Structure", myo?.epicardial ? "Epicardium (myocardium = epi − LV)" : role]);
      rows.push(["Slice / frame", `${geo.slice! + 1} / ${geo.frame! + 1}`]);
      rows.push([`Area`, `${(ringArea(geo) * sx * sy).toFixed(1)} ${unit}²`]);
      if (myo?.epicardial) rows.push(["Myocardium area", `${(myo.area * sx * sy).toFixed(1)} ${unit}²`]);
      rows.push(["Perimeter", `${perimeterMm(geo, sx, sy).toFixed(1)} ${unit}`]);
      rows.push([geo.type === "spline" ? "Control points" : "Vertices", String(geo.points.length)]);
    } else if (isMask(a)) {
      const geo = a.geometry;
      const n = rleForeground(geo.counts);
      rows.push(["Structure", role], ["Slice / frame", `${geo.slice! + 1} / ${geo.frame! + 1}`]);
      rows.push(["Area", `${(n * sx * sy).toFixed(1)} ${unit}² (${n} px)`]);
    } else return rows;
    rows.push(["Source", String(a.attributes?.source ?? "manual")]);
    return rows;
  },
};
