import type { Annotation } from "@studio/contracts/types";
import { cellKey, interpolateContour, isContour, isMask, labelValue, maskToControlPoints, type Cell, type ContourAnn, type ContourGeometry, type MaskAnn, type Structures } from "../model";
import { EMPTY_CELL } from "./engine";

/**
 * Slice × frame editing operations (copy-forward, interpolation, reference import) as pure
 * functions: they return the annotations to create / remove and the message to show; the
 * host commits them as one undo step.
 */

type NewAnn = (init: { label: string; geometry: Annotation["geometry"]; attributes: Annotation["attributes"] }) => Annotation;

export interface EditResult {
  upsert: Annotation[];
  remove: string[];
  message: string;
  /** Where to navigate afterwards. */
  goto?: { slice: number; frame: number };
}

/**
 * Copy `sources` (the selection, else everything visible in the cell) to the neighbouring
 * slice (`dz`) or frame (`df`, cyclic). Same-label annotations at the target block the copy
 * unless `replace`, and locked ones always do.
 */
export function copyCell(o: {
  cells: Map<string, Cell>;
  cell: Cell;
  slice: number;
  frame: number;
  nz: number;
  nt: number;
  dz: number;
  df: number;
  replace: boolean;
  selected: (ContourAnn | MaskAnn)[];
  visible: (a: Annotation) => boolean;
  editable: (a: Annotation) => boolean;
  newAnn: NewAnn;
}): EditResult | string {
  const tz = o.slice + o.dz;
  if (tz < 0 || tz >= o.nz) return "No slice in that direction";
  const tf = (o.frame + o.df + o.nt) % o.nt;
  const sources: (ContourAnn | MaskAnn)[] = o.selected.length ? o.selected : [...o.cell.contours, ...o.cell.masks].filter(o.visible);
  if (!sources.length) return "Nothing to copy on this slice/frame";
  const target = o.cells.get(cellKey(tz, tf)) ?? EMPTY_CELL;
  const created: Annotation[] = [];
  const skipped: string[] = [];
  const removed: string[] = [];
  for (const s of sources) {
    const clashes: Annotation[] = isContour(s) ? target.contours.filter((c) => c.label === s.label) : target.masks.filter((m) => m.label === s.label);
    if (clashes.length) {
      // Replace only what may be edited; locked targets are kept and the copy skipped.
      if (!o.replace || clashes.some((c) => !o.editable(c))) {
        skipped.push(s.label);
        continue;
      }
      removed.push(...clashes.map((c) => c.id));
    }
    created.push(o.newAnn({ label: s.label, geometry: { ...s.geometry, slice: tz, frame: tf } as Annotation["geometry"], attributes: { ...s.attributes, source: "copied" } }));
  }
  const where = o.dz ? `slice ${tz + 1}` : `frame ${tf + 1}`;
  const message = `${created.length ? `${removed.length ? "Replaced" : "Copied"} ${created.length} to ${where}` : `Nothing copied to ${where}`}${
    skipped.length ? ` · already there: ${[...new Set(skipped)].join(", ")} (Shift+Alt+arrow replaces)` : ""
  }`;
  return { upsert: created, remove: removed, message, goto: { slice: tz, frame: tf } };
}

/**
 * Fill empty frames (of this slice) or slices (of this frame) between key contours of each
 * target label by shape interpolation. `cyclic` also wraps from the last key frame to the first.
 */
export function interpolateCells(o: {
  cells: Map<string, Cell>;
  axis: "frame" | "slice";
  slice: number;
  frame: number;
  nz: number;
  nt: number;
  cyclic: boolean;
  targets: string[];
  newAnn: NewAnn;
}): EditResult | string {
  const { axis, slice, frame } = o;
  if (!o.targets.length) return "Pick a structure first";
  const n = axis === "frame" ? o.nt : o.nz;
  const cyclic = axis === "frame" && o.cyclic;
  const at = (k: number) => o.cells.get(axis === "frame" ? cellKey(slice, k) : cellKey(k, frame)) ?? EMPTY_CELL;
  const created: Annotation[] = [];
  const tooFew: string[] = [];
  for (const label of o.targets) {
    const keys: { k: number; g: ContourGeometry }[] = [];
    for (let k = 0; k < n; k++) {
      const cs = at(k).contours.filter((c) => c.label === label && c.attributes?.source !== "interpolated");
      if (cs.length === 1) keys.push({ k, g: cs[0].geometry });
    }
    if (keys.length < 2) {
      tooFew.push(label);
      continue;
    }
    const pairs: [(typeof keys)[number], (typeof keys)[number], number][] = [];
    for (let i = 0; i + 1 < keys.length; i++) pairs.push([keys[i], keys[i + 1], keys[i + 1].k]);
    // A cyclic sequence (e.g. the cardiac cycle): the last key frame also leads back to the first.
    if (cyclic) pairs.push([keys[keys.length - 1], keys[0], keys[0].k + n]);
    for (const [a, b, bk] of pairs) {
      for (let kk = a.k + 1; kk < bk; kk++) {
        const k = kk % n;
        const c = at(k);
        if (c.contours.some((x) => x.label === label) || c.masks.some((x) => x.label === label)) continue;
        const points = interpolateContour(a.g, b.g, (kk - a.k) / (bk - a.k));
        created.push(o.newAnn({ label, geometry: { type: "spline", points, slice: axis === "frame" ? slice : k, frame: axis === "frame" ? k : frame }, attributes: { source: "interpolated" } }));
      }
    }
  }
  const where = axis === "frame" ? "of this slice" : "of this frame";
  if (!created.length) return tooFew.length ? `Draw ${tooFew.join(", ")} on at least two ${axis}s ${where} first` : `No empty ${axis}s between key contours`;
  const message = `Interpolated ${created.length} contour${created.length > 1 ? "s" : ""} (${o.targets.filter((t) => !tooFew.includes(t)).join(", ")}) across ${axis}s${cyclic ? ", wrapping the cycle" : ""}${
    tooFew.length ? ` · need two keys: ${tooFew.join(", ")}` : ""
  }`;
  return { upsert: created, remove: [], message };
}

/**
 * Turn reference label volumes into editable spline contours, one per label per slice that
 * isn't drawn yet. With structure roles, a `myo` region becomes its outer border (the ring
 * plus the `lv` cavity it surrounds).
 */
export function importReference(o: {
  refs: { frame: number; volume: { data: ArrayLike<number> } }[];
  slices: number[];
  cells: Map<string, Cell>;
  labels: string[];
  structs: Structures;
  nx: number;
  ny: number;
  newAnn: NewAnn;
}): EditResult | string {
  if (!o.refs.length) return "No reference segmentation on this frame";
  const n = o.nx * o.ny;
  const lvValue = o.structs.lv ? labelValue(o.labels, o.structs.lv) : -1;
  const created: Annotation[] = [];
  for (const r of o.refs) {
    for (const z of o.slices) {
      const c = o.cells.get(cellKey(z, r.frame)) ?? EMPTY_CELL;
      const src = r.volume.data;
      for (const name of o.labels) {
        if (c.contours.some((x) => x.label === name) || c.masks.some((x) => x.label === name)) continue;
        const value = labelValue(o.labels, name);
        const outer = name === o.structs.myo && lvValue > 0;
        const mask = new Uint8Array(n);
        let any = 0;
        for (let i = 0; i < n; i++) {
          const v = src[z * n + i];
          if (v === value) any++;
          mask[i] = v === value || (outer && v === lvValue) ? 1 : 0;
        }
        if (!any) continue;
        const points = maskToControlPoints(mask, o.nx, o.ny);
        if (!points) continue;
        created.push(o.newAnn({ label: name, geometry: { type: "spline", points, slice: z, frame: r.frame }, attributes: { source: "reference" } }));
      }
    }
  }
  if (!created.length) return "Reference already imported (or this slice has no reference structures)";
  return { upsert: created, remove: [], message: `Imported ${created.length} reference contour${created.length > 1 ? "s" : ""} as editable splines` };
}

export const isCellAnnotation = (a: Annotation): a is ContourAnn | MaskAnn => isContour(a) || isMask(a);
