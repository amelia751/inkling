/** Pure checks the volume viewer runs on a loaded NIfTI (todo18 §2 C). */

/** An integer volume with at most 16 distinct values is a label map: show it as a mask. */
export const MAX_LABEL_VALUES = 16;

export function isLabelVolume(integer: boolean, values: Iterable<number>): boolean {
  if (!integer) return false;
  const seen = new Set<number>();
  for (const v of values) {
    seen.add(v);
    if (seen.size > MAX_LABEL_VALUES) return false;
  }
  return seen.size > 0;
}

/** 4×4 row-major affine; NIfTI qform and sform may disagree (bad exporters). */
export type Affine = number[];

/** Which affine to use (sform when sform_code > 0, else qform) and a warning when both are set and differ by more than `tol` mm. */
export function chooseAffine(q: { code: number; affine: Affine }, s: { code: number; affine: Affine }, tol = 1e-3): { affine: Affine; source: "sform" | "qform"; warning?: string } {
  const pick = s.code > 0 ? { affine: s.affine, source: "sform" as const } : { affine: q.affine, source: "qform" as const };
  if (q.code > 0 && s.code > 0 && q.affine.some((v, i) => Math.abs(v - (s.affine[i] ?? 0)) > tol)) {
    return { ...pick, warning: "This volume's qform and sform disagree; orientation follows the sform" };
  }
  return pick;
}
