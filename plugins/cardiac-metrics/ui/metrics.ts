import { cellKey, cellLabelMap, labelValue, STRUCT_KEYS, STRUCT_SHORT, type Cell, type FrameMetrics, type Grid, type StructKey, type Structures } from "@plugins/cine/public";

/**
 * Cardiac function from the cine module's per-frame coverage: EDV / ESV / SV / EF per
 * ventricle (Simpson's method of discs), LV mass, warnings, the ED/ES suggestion from the
 * LV volume curve, and Dice against reference segmentations.
 */

/** Myocardial tissue density (g/mL) used for LV mass. */
export const MYO_DENSITY = 1.05;

export interface FunctionMetrics {
  edv: number | null;
  esv: number | null;
  sv: number | null;
  ef: number | null;
}

export interface CineMetrics {
  frames: FrameMetrics[];
  ed: number | null;
  es: number | null;
  lv: FunctionMetrics;
  rv: FunctionMetrics;
  /** LV mass at ED (g) = MYO volume × 1.05. */
  mass: number | null;
  massEs: number | null;
  bsa: number | null;
  warnings: string[];
  /** Frame with the largest / smallest LV volume, once ≥ 2 frames have LV contours. */
  suggested: { ed: number; es: number } | null;
}

export function mosteller(heightCm: number | null | undefined, weightKg: number | null | undefined): number | null {
  if (!heightCm || !weightKg) return null;
  return Math.sqrt((heightCm * weightKg) / 3600);
}

export function computeMetrics(opts: { frames: FrameMetrics[]; ed: number | null; es: number | null; bsa: number | null }): CineMetrics {
  const { frames } = opts;
  const fn = (k: StructKey): FunctionMetrics => {
    const edv = opts.ed !== null ? frames[opts.ed]?.volume[k] ?? null : null;
    const esv = opts.es !== null ? frames[opts.es]?.volume[k] ?? null : null;
    const sv = edv !== null && esv !== null ? edv - esv : null;
    return { edv, esv, sv, ef: sv !== null && edv ? (sv / edv) * 100 : null };
  };
  const lv = fn("lv"), rv = fn("rv");
  const myoAt = (f: number | null) => (f !== null ? frames[f]?.volume.myo ?? null : null);
  const massOf = (v: number | null) => (v !== null ? v * MYO_DENSITY : null);

  const warnings: string[] = [];
  if (opts.ed === null || opts.es === null) warnings.push("Mark both ED and ES frames to compute function.");
  for (const [name, f] of [["ED", opts.ed], ["ES", opts.es]] as const) {
    if (f === null) continue;
    for (const k of ["lv", "rv"] as StructKey[]) {
      const fm = frames[f];
      if (!fm) continue;
      if (fm.status[k] === "empty") warnings.push(`${STRUCT_SHORT[k]} not contoured at ${name} (frame ${f + 1}).`);
      else if (fm.status[k] === "partial" && !fm.missing[k].length)
        warnings.push(`${STRUCT_SHORT[k]} at ${name} covers fewer slices than other frames: values are provisional.`);
      else if (fm.status[k] === "partial")
        warnings.push(`${STRUCT_SHORT[k]} at ${name} is missing slice${fm.missing[k].length > 1 ? "s" : ""} ${fm.missing[k].map((z) => z + 1).join(", ")}: values are provisional.`);
    }
  }
  if (lv.sv !== null && rv.sv !== null && Math.max(lv.sv, rv.sv) > 0) {
    const diff = Math.abs(lv.sv - rv.sv);
    if (diff > 10 && diff / Math.max(lv.sv, rv.sv) > 0.1)
      warnings.push(`LV SV ${lv.sv.toFixed(0)} mL vs RV SV ${rv.sv.toFixed(0)} mL differ by ${diff.toFixed(0)} mL (check basal slices or valve disease).`);
  }

  const lvFrames = frames.filter((f) => f.volume.lv !== null && f.status.lv === "complete");
  let suggested: CineMetrics["suggested"] = null;
  if (lvFrames.length >= 2) {
    const max = lvFrames.reduce((a, b) => (b.volume.lv! > a.volume.lv! ? b : a));
    const min = lvFrames.reduce((a, b) => (b.volume.lv! < a.volume.lv! ? b : a));
    if (max.frame !== min.frame) suggested = { ed: max.frame, es: min.frame };
  }

  return { frames, ed: opts.ed, es: opts.es, lv, rv, mass: massOf(myoAt(opts.ed)), massEs: massOf(myoAt(opts.es)), bsa: opts.bsa, warnings, suggested };
}

// ---------- QA ----------

export interface DiceRow {
  slice: number;
  dice: Record<StructKey, number | null>;
}

/** Per-slice Dice between the user's label map and a reference label volume, on slices the user annotated. */
export function diceVsReference(cells: Map<string, Cell>, frame: number, ref: ArrayLike<number>, labels: string[], structs: Structures, grid: Grid): DiceRow[] {
  const s = structs;
  const n = grid.nx * grid.ny;
  const rows: DiceRow[] = [];
  for (let z = 0; z < grid.nz; z++) {
    const cell = cells.get(cellKey(z, frame));
    if (!cell) continue;
    const mine = cellLabelMap(cell, labels, structs, grid.nx, grid.ny);
    const dice = { rv: null, myo: null, lv: null } as Record<StructKey, number | null>;
    for (const k of STRUCT_KEYS) {
      if (!s[k]) continue;
      const v = labelValue(labels, s[k]!);
      let a = 0, b = 0, both = 0;
      for (let i = 0; i < n; i++) {
        const x = mine[i] === v, y = ref[z * n + i] === v;
        if (x) a++;
        if (y) b++;
        if (x && y) both++;
      }
      // Only score structures the user drew on this slice.
      if (a) dice[k] = (2 * both) / (a + b);
    }
    rows.push({ slice: z, dice });
  }
  return rows;
}
