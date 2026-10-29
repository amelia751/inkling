import { rleForeground } from "@/kits/overlay2d/geometry";
import type { InspectFn } from "@/platform/module";
import { useStudio } from "@/stores/studio";
import { cellKey, groupCells, isContour, isMask, isPhase, myoArea, perimeterMm, ringArea, type Grid } from "./model";
import { cineConfig, RUNTIME, structuresOf } from "./public";

const ROLE = { lv: "LV endocardium", rv: "RV endocardium", myo: "Myocardium" } as const;

/** Selection inspector rows: areas and perimeters in mm (grid from `runtime.grid`), structure role, key frames. */
export const inspectCine: InspectFn = (a, { env, item, runtime }) => {
  const config = cineConfig(env);
  const grid = runtime.get<Grid>(RUNTIME.grid);
  const sx = grid?.spacing[0] ?? 1, sy = grid?.spacing[1] ?? 1;
  const unit = grid ? "mm" : "px";
  const rows: [string, string][] = [];
  if (isPhase(a)) {
    const kf = config.keyFrames.find((k) => k.id === a.attributes.phase);
    return [["Phase", kf?.label ?? a.attributes.phase], ["Frame", String(a.geometry.frame + 1)]];
  }
  const s = structuresOf(config);
  const roleKey = a.label === s.lv ? "lv" : a.label === s.rv ? "rv" : a.label === s.myo ? "myo" : null;
  const role = roleKey ? ROLE[roleKey] : a.label;
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
};
