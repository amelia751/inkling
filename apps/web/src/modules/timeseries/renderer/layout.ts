/** CSS reference pixel: 96 px per inch. True paper scale only after screen calibration (see calibration.ts). */
export const PX_PER_MM = 96 / 25.4;
/** Minimum label gutter; paper mode widens it so the calibration pulse keeps its true 200 ms width. */
export const GUTTER = 64;
/** Room in the gutter for the lead name, left of the calibration pulse. */
const LABEL_W = 36;
export const RHYTHM_TRACK = 22;
export const RIGHT_PAD = 6;

export type LayoutMode = "12x1" | "6x2" | "3x4" | "single";
export type ScaleMode = "fit" | "paper";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Strip-chart geometry: which channel ("lead" in ECG) is drawn where, over which time range.
 * Pure functions of the plot size and display settings; unit-tested in layout.test.ts.
 */

/** One trace strip: a channel drawn over the time range [t0, t1] inside a rect. */
export interface Panel extends Rect {
  lead: string;
  t0: number;
  t1: number;
  col: number;
  row: number;
  /** Full-width rhythm strip (the primary channel) under a 3×4 layout. */
  rhythmStrip?: boolean;
}

export interface Frame {
  panels: Panel[];
  plot: Rect;
  /** Rhythm-episode track under the leads, spanning the whole window. */
  track: Rect & { t0: number; t1: number };
  cols: number;
  /** Seconds shown across the whole plot (all columns together). */
  span: number;
  offset: number;
  pxPerSec: number;
  /** Pixels per mV at the global gain; per-lead gain scales this. */
  pxPerMv: number;
  /** CSS px per mm used for paper scale. */
  pxPerMm: number;
  /** Left gutter width (lead names + calibration pulse). */
  gutter: number;
}

export interface FrameInput {
  width: number;
  height: number;
  leads: string[];
  mode: LayoutMode;
  focus: string;
  scale: ScaleMode;
  /** mm/s */
  speed: number;
  /** mm/mV */
  gain: number;
  /** Seconds in fit mode. */
  windowSec: number;
  offset: number;
  duration: number;
  /** CSS px per mm (calibrated); defaults to the CSS reference 96/25.4. */
  pxPerMm?: number;
  /** Canonical channel order for the column layouts (ECG: the 12 standard leads). */
  order?: string[];
  /** Channel of the full-width strip under a 3×4 layout, when the record has it. */
  stripChannel?: string;
}

/** Columns of the 3×4 / 6×2 formats: the canonical order when the record has all of it, else even chunks. */
export function columnsFor(leads: string[], mode: LayoutMode, focus: string, order: string[] = []): string[][] {
  const std = order.length > 0 && order.every((l) => leads.includes(l));
  if (mode === "single") return [[leads.includes(focus) ? focus : leads[0]]];
  if (mode === "12x1") return [leads];
  const per = mode === "3x4" ? 3 : 6;
  const src = std ? order : leads;
  const cols: string[][] = [];
  for (let i = 0; i < src.length; i += per) cols.push(src.slice(i, i + per));
  return cols;
}

/** Window length (s) the current scale implies for a plot width. */
export function spanFor(plotW: number, scale: ScaleMode, speed: number, windowSec: number, duration: number, pxPerMm = PX_PER_MM) {
  return scale === "paper" ? plotW / (speed * pxPerMm) : Math.min(windowSec, duration);
}

/** Gutter that fits the lead name plus a true-width (200 ms) calibration pulse in paper mode. */
export function gutterFor(scale: ScaleMode, speed: number, pxPerMm: number) {
  return scale === "paper" ? Math.max(GUTTER, Math.ceil(0.2 * speed * pxPerMm) + LABEL_W + 12) : GUTTER;
}

export function computeFrame(f: FrameInput): Frame {
  const pxPerMm = f.pxPerMm ?? PX_PER_MM;
  const gutter = gutterFor(f.scale, f.speed, pxPerMm);
  const plot: Rect = { x: gutter, y: 0, w: Math.max(10, f.width - gutter - RIGHT_PAD), h: Math.max(10, f.height - RHYTHM_TRACK) };
  const colLeads = columnsFor(f.leads, f.mode, f.focus, f.order);
  const cols = colLeads.length;
  const strip = f.mode === "3x4" && !!f.stripChannel && f.leads.includes(f.stripChannel);
  const rows = Math.max(...colLeads.map((c) => c.length)) + (strip ? 1 : 0);
  const span = spanFor(plot.w, f.scale, f.speed, f.windowSec, f.duration, pxPerMm);
  const offset = Math.max(0, Math.min(f.offset, Math.max(0, f.duration - span)));
  const pxPerSec = plot.w / span;
  const rowH = plot.h / rows;
  // Fit: ±1.5 mV per row at 10 mm/mV (±3 mV when one lead fills the plot, so QRS is not clipped).
  const pxPerMv = f.scale === "paper" ? f.gain * pxPerMm : (rowH / 2 / (rows === 1 ? 3 : 1.5)) * (f.gain / 10);
  const colW = plot.w / cols;
  const colSpan = span / cols;
  const panels: Panel[] = [];
  colLeads.forEach((leads, col) =>
    leads.forEach((lead, row) =>
      panels.push({ lead, col, row, x: plot.x + col * colW, y: plot.y + row * rowH, w: colW, h: rowH, t0: offset + col * colSpan, t1: offset + (col + 1) * colSpan }),
    ),
  );
  if (strip) panels.push({ lead: f.stripChannel!, col: 0, row: rows - 1, x: plot.x, y: plot.y + (rows - 1) * rowH, w: plot.w, h: rowH, t0: offset, t1: offset + span, rhythmStrip: true });
  return {
    panels,
    plot,
    track: { x: plot.x, y: plot.y + plot.h, w: plot.w, h: RHYTHM_TRACK, t0: offset, t1: offset + span },
    cols,
    span,
    offset,
    pxPerSec,
    pxPerMv,
    pxPerMm,
    gutter,
  };
}

export const xOf = (p: { x: number; t0: number }, pxPerSec: number, t: number) => p.x + (t - p.t0) * pxPerSec;
export const tOf = (p: { x: number; t0: number }, pxPerSec: number, x: number) => p.t0 + (x - p.x) / pxPerSec;

export function panelAt(frame: Frame, x: number, y: number): Panel | undefined {
  return frame.panels.find((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
}

/** Lead whose name label is under the pointer: gutter for column 0, top-left corner for the others. */
export function leadLabelAt(frame: Frame, x: number, y: number): Panel | undefined {
  return frame.panels.find((p) => {
    if (y < p.y || y >= p.y + p.h) return false;
    if (p.col === 0) return x < LABEL_W && x >= 0 && y < p.y + p.h / 2 + 10 && y > p.y + p.h / 2 - 12;
    return x >= p.x + 2 && x < p.x + 34 && y < p.y + 16;
  });
}
