import { resolveLabelColor, resolveToken } from "@/lib/labels";
import type { Annotation } from "@/types";
import { channelOf, codeOf, kindOf, peakOf, rangeOf, rhythmOf, waveOf } from "../model";
import { GUTTER, type Frame, type Panel, xOf } from "./layout";

/**
 * Canvas drawing of the strip chart: grid (ECG paper or plain), traces, spans, instants,
 * the track of record-level spans, drafts, selection handles, caliper and the overview.
 * Pure functions of a Scene; the engine builds the scene and owns interaction.
 */

export type Draft =
  | { kind: "interval" | "wave"; lead: string; t0: number; t1: number; label: string; wave?: string }
  | { kind: "rhythm"; t0: number; t1: number; rhythm: string };

export interface Caliper {
  t0: number;
  t1: number;
  y0: number;
  y1: number;
  panel: Panel;
  /** Alt-drag: Q onset → T end, read out as QT/QTc. */
  qt: boolean;
  /** Lines describing the measurement, drawn next to the caliper. */
  readout: string[];
}

export interface Scene {
  width: number;
  height: number;
  frame: Frame;
  fs: number;
  leads: Record<string, Float32Array>;
  baseline: Record<string, number>;
  pxPerMvFor: (lead: string) => number;
  anns: Annotation[];
  /** Primary selection: gets edit handles. */
  selectedId: string | null;
  /** Every selected annotation (multi-select), highlighted. */
  selectedIds: Set<string>;
  labels: string[];
  opacity: number;
  /** ECG paper grid (40/200 ms boxes, mm squares in paper mode) or a plain time ruler. */
  grid: "ecg" | "plain";
  paper: boolean;
  /** Top-right note: speed, gain, filter band. */
  note: string;
  draft: Draft | null;
  caliper: Caliper | null;
  marchOut: boolean;
  focusLead?: string;
  /** Rubber-band selection rectangle in CSS px. */
  band?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Codes of instants drawn in the label colour (the vocabulary's first code); others are highlighted. */
  normalCode?: string;
  /** Track codes, for stable colours per code. */
  trackCodes: string[];
  trackLabel: string;
}

function colors() {
  return {
    trace: resolveToken("--canvas-foreground", 0.92),
    text: resolveToken("--canvas-foreground", 0.7),
    dim: resolveToken("--canvas-foreground", 0.45),
    rule: resolveToken("--canvas-foreground", 0.1),
    ai: resolveToken("--prov-ai"),
    primary: resolveToken("--primary"),
    warn: resolveToken("--chart-3"),
  };
}
type Colors = ReturnType<typeof colors>;

const onLead = (lead: string, p: Panel) => lead === "all" || lead === p.lead;
/** Interval and wave spans (on channels), as [start, end]. */
function channelSpan(a: Annotation): [number, number] | null {
  const k = kindOf(a);
  return k === "interval" || k === "wave" ? rangeOf(a.geometry) : null;
}

export function drawScene(ctx: CanvasRenderingContext2D, s: Scene) {
  const c = colors();
  const { frame } = s;
  ctx.clearRect(0, 0, s.width, s.height);
  ctx.lineCap = "butt";
  drawGrid(ctx, s);

  for (const p of frame.panels) {
    ctx.save();
    ctx.beginPath();
    // Paper mode lets tall complexes run into neighbouring rows, as on a printout.
    if (s.paper) ctx.rect(p.x, frame.plot.y, p.w, frame.plot.h);
    else ctx.rect(p.x, p.y, p.w, p.h);
    ctx.clip();
    drawSpans(ctx, s, p);
    drawTrace(ctx, s, p, c);
    drawBeats(ctx, s, p, c);
    drawDraft(ctx, s, p);
    drawSelection(ctx, s, p, c);
    ctx.restore();
  }
  drawFrameChrome(ctx, s, c);
  drawRhythmTrack(ctx, s, c);
  if (s.caliper) drawCaliper(ctx, s, s.caliper, c);
  if (s.band) {
    const { x0, y0, x1, y1 } = s.band;
    ctx.fillStyle = resolveToken("--primary", 0.12);
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeStyle = resolveToken("--primary", 0.9);
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.setLineDash([]);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, s: Scene) {
  const { plot, pxPerSec, offset } = s.frame;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  const vlines = (step: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.ceil(offset / step) * step; t <= offset + s.frame.span + 1e-9; t += step) {
      const x = Math.round(plot.x + (t - offset) * pxPerSec) + 0.5;
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
    }
    ctx.stroke();
  };
  if (s.paper) {
    // 1 mm minor / 5 mm major squares, scrolling with the trace horizontally.
    const mm = s.frame.pxPerMm;
    const mmSec = mm / pxPerSec;
    const hlines = (stepPx: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let y = plot.y; y <= plot.y + plot.h; y += stepPx) {
        ctx.moveTo(plot.x, Math.round(y) + 0.5);
        ctx.lineTo(plot.x + plot.w, Math.round(y) + 0.5);
      }
      ctx.stroke();
    };
    const minor = "hsl(0 80% 62% / 0.10)";
    const major = "hsl(0 80% 62% / 0.26)";
    vlines(mmSec, minor);
    hlines(mm, minor);
    vlines(mmSec * 5, major);
    hlines(mm * 5, major);
  } else if (s.grid === "ecg") {
    for (const [step, alpha] of [[0.04, 0.05], [0.2, 0.12]] as const) {
      if (pxPerSec * step < 4) continue;
      vlines(step, `rgba(255,255,255,${alpha})`);
    }
    if (pxPerSec * 0.2 < 4) vlines(1, "rgba(255,255,255,0.1)");
  } else {
    // Plain ruler: a 1-2-5 step giving lines at least 60 px apart, with fifths as minor lines.
    const major = niceStep(60 / pxPerSec);
    if ((major / 5) * pxPerSec >= 8) vlines(major / 5, "rgba(255,255,255,0.04)");
    vlines(major, "rgba(255,255,255,0.1)");
  }
  ctx.restore();
}

/** Smallest 1-2-5 × 10^k step ≥ x. */
export function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (m * p >= x - 1e-12) return m * p;
  return 10 * p;
}

function drawTrace(ctx: CanvasRenderingContext2D, s: Scene, p: Panel, c: Colors) {
  const x = s.leads[p.lead];
  if (!x) return;
  const { fs } = s;
  const pps = s.frame.pxPerSec;
  const k = s.pxPerMvFor(p.lead);
  const base = s.baseline[p.lead] ?? 0;
  const mid = p.y + p.h / 2;
  const i0 = Math.max(0, Math.floor(p.t0 * fs) - 1);
  const i1 = Math.min(x.length - 1, Math.ceil(p.t1 * fs) + 1);
  const yOf = (v: number) => mid - (v - base) * k;
  ctx.strokeStyle = c.trace;
  ctx.lineWidth = s.paper ? 1.1 : 1.2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  const spp = fs / pps;
  if (spp <= 2) {
    for (let i = i0; i <= i1; i++) {
      const px = xOf(p, pps, i / fs);
      if (i === i0) ctx.moveTo(px, yOf(x[i]));
      else ctx.lineTo(px, yOf(x[i]));
    }
  } else {
    // Min/max envelope per pixel column keeps QRS spikes visible when zoomed out.
    let i = i0;
    let first = true;
    while (i <= i1) {
      const px = Math.floor(xOf(p, pps, i / fs));
      let lo = x[i];
      let hi = x[i];
      let j = i + 1;
      while (j <= i1 && Math.floor(xOf(p, pps, j / fs)) === px) {
        if (x[j] < lo) lo = x[j];
        if (x[j] > hi) hi = x[j];
        j++;
      }
      if (first) {
        ctx.moveTo(px, yOf(x[i]));
        first = false;
      }
      ctx.lineTo(px, yOf(hi));
      ctx.lineTo(px, yOf(lo));
      i = j;
    }
  }
  ctx.stroke();
}

function drawSpans(ctx: CanvasRenderingContext2D, s: Scene, p: Panel) {
  const pps = s.frame.pxPerSec;
  for (const a of s.anns) {
    const r = channelSpan(a);
    if (!r || !onLead(channelOf(a.geometry), p)) continue;
    const isWave = kindOf(a) === "wave";
    const [t0, t1] = r;
    if (t1 < p.t0 || t0 > p.t1) continue;
    const x0 = xOf(p, pps, t0);
    const x1 = xOf(p, pps, t1);
    const ai = a.provenance === "ai-suggested";
    const sel = s.selectedIds.has(a.id);
    const col = (alpha: number) => (ai ? resolveToken("--prov-ai", alpha) : resolveLabelColor(s.labels, a.label, alpha));
    ctx.fillStyle = col((sel ? 0.32 : isWave ? 0.14 : 0.2) * s.opacity);
    ctx.fillRect(x0, p.y + 1, x1 - x0, p.h - 2);
    ctx.strokeStyle = col(0.9);
    ctx.lineWidth = sel ? 2 : 1.25;
    ctx.setLineDash(ai ? [4, 3] : []);
    if (!isWave) {
      ctx.fillStyle = col(1);
      ctx.fillRect(x0, p.y + 1, x1 - x0, 2);
      if (ai) ctx.strokeRect(x0, p.y + 1, x1 - x0, p.h - 2);
    } else {
      ctx.beginPath();
      ctx.moveTo(x0, p.y + 1);
      ctx.lineTo(x0, p.y + p.h - 1);
      ctx.moveTo(x1, p.y + 1);
      ctx.lineTo(x1, p.y + p.h - 1);
      ctx.stroke();
      const peak = peakOf(a);
      if (peak !== undefined) {
        const xp = xOf(p, pps, peak);
        ctx.fillStyle = col(1);
        ctx.beginPath();
        ctx.moveTo(xp - 3.5, p.y + 2);
        ctx.lineTo(xp + 3.5, p.y + 2);
        ctx.lineTo(xp, p.y + 7);
        ctx.fill();
      }
      if (p.h >= 28 && x1 - x0 > 12) {
        ctx.fillStyle = col(1);
        ctx.font = "600 9px Inter, sans-serif";
        ctx.fillText(waveOf(a), x0 + 2, p.y + p.h - 4);
      }
    }
    ctx.setLineDash([]);
  }
}

function beatColor(labels: string[], a: Annotation, c: Colors, normal: string | undefined) {
  if (a.provenance === "ai-suggested") return c.ai;
  return normal === undefined || codeOf(a) === normal ? resolveLabelColor(labels, a.label) : c.warn;
}

function drawBeats(ctx: CanvasRenderingContext2D, s: Scene, p: Panel, c: Colors) {
  const pps = s.frame.pxPerSec;
  ctx.textAlign = "center";
  ctx.font = "700 10px Inter, sans-serif";
  for (const a of s.anns) {
    if (kindOf(a) !== "beat") continue;
    const t = rangeOf(a.geometry)![0];
    const lead = channelOf(a.geometry);
    if (!onLead(lead, p) || t < p.t0 || t > p.t1) continue;
    const x = xOf(p, pps, t);
    const color = beatColor(s.labels, a, c, s.normalCode);
    const ai = a.provenance === "ai-suggested";
    const sel = s.selectedIds.has(a.id);
    const showLetter = lead !== "all" || p.row === 0 || p.rhythmStrip || s.frame.panels.length === 1;
    if (sel) {
      ctx.strokeStyle = resolveToken("--primary", 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, p.y);
      ctx.lineTo(x + 0.5, p.y + p.h);
      ctx.stroke();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = sel ? 2.5 : 1.5;
    ctx.setLineDash(ai ? [2, 2] : []);
    ctx.globalAlpha = showLetter ? 1 : 0.55;
    ctx.beginPath();
    const top = showLetter ? p.y + 13 : p.y + 2;
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + (showLetter ? 7 : 6));
    ctx.stroke();
    ctx.setLineDash([]);
    if (showLetter) {
      if (sel) {
        ctx.fillStyle = c.primary;
        ctx.fillRect(x - 7, p.y + 1, 14, 12);
        ctx.fillStyle = "#fff";
      } else ctx.fillStyle = color;
      ctx.fillText(codeOf(a), x, p.y + 11);
    }
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = "left";
}

function drawDraft(ctx: CanvasRenderingContext2D, s: Scene, p: Panel) {
  const d = s.draft;
  if (!d || d.kind === "rhythm" || !onLead(d.lead, p)) return;
  const pps = s.frame.pxPerSec;
  const a = Math.min(d.t0, d.t1);
  const b = Math.max(d.t0, d.t1);
  if (b < p.t0 || a > p.t1) return;
  ctx.fillStyle = resolveLabelColor(s.labels, d.label, 0.3);
  ctx.fillRect(xOf(p, pps, a), p.y, (b - a) * pps, p.h);
  if (d.wave) {
    ctx.fillStyle = "#fff";
    ctx.font = "600 10px Inter, sans-serif";
    ctx.fillText(d.wave, xOf(p, pps, a) + 3, p.y + 12);
  }
}

export function handleSquare(ctx: CanvasRenderingContext2D, x: number, y: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.lineWidth = 1.25;
  ctx.fillRect(x - 3.5, y - 5, 7, 10);
  ctx.strokeRect(x - 3.5, y - 5, 7, 10);
}

function drawSelection(ctx: CanvasRenderingContext2D, s: Scene, p: Panel, c: Colors) {
  const a = s.anns.find((x) => x.id === s.selectedId);
  if (!a) return;
  const pps = s.frame.pxPerSec;
  const mid = p.y + p.h / 2;
  const r = channelSpan(a);
  if (r && onLead(channelOf(a.geometry), p)) {
    for (const t of r) if (t >= p.t0 && t <= p.t1) handleSquare(ctx, xOf(p, pps, t), mid, "#fff");
    const peak = kindOf(a) === "wave" ? peakOf(a) : undefined;
    if (peak !== undefined && peak >= p.t0 && peak <= p.t1) handleSquare(ctx, xOf(p, pps, peak), p.y + 9, c.primary);
  }
}

function drawFrameChrome(ctx: CanvasRenderingContext2D, s: Scene, c: Colors) {
  const { frame } = s;
  ctx.font = "11px Inter, sans-serif";
  for (const p of frame.panels) {
    const mid = p.y + p.h / 2;
    // Row and column rules.
    ctx.strokeStyle = c.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x, Math.round(p.y + p.h) + 0.5);
    ctx.lineTo(p.x + p.w, Math.round(p.y + p.h) + 0.5);
    if (p.col > 0) {
      ctx.moveTo(Math.round(p.x) + 0.5, p.y + 2);
      ctx.lineTo(Math.round(p.x) + 0.5, p.y + p.h - 2);
    }
    ctx.stroke();
    const focus = s.focusLead === p.lead;
    if (p.col === 0) {
      ctx.fillStyle = focus ? c.primary : c.text;
      ctx.font = `${focus ? 600 : 500} 11px Inter, sans-serif`;
      ctx.fillText(p.lead, 6, mid + 4);
      drawCalibration(ctx, s, p, c);
    } else {
      ctx.font = "500 11px Inter, sans-serif";
      const w = ctx.measureText(p.lead).width + 6;
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(p.x + 3, p.y + 2, w, 13);
      ctx.fillStyle = c.text;
      ctx.fillText(p.lead, p.x + 6, p.y + 12);
    }
  }
  if (s.note) {
    ctx.font = "10px Inter, sans-serif";
    const w = ctx.measureText(s.note).width + 10;
    const x = frame.plot.x + frame.plot.w - w - 2;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x, frame.plot.y + 2, w, 14);
    ctx.fillStyle = c.text;
    ctx.fillText(s.note, x + 5, frame.plot.y + 12);
  }
}

/** 1 mV × 200 ms calibration pulse at the row start, scaled by the lead's gain. */
function drawCalibration(ctx: CanvasRenderingContext2D, s: Scene, p: Panel, c: Colors) {
  const h = s.pxPerMvFor(p.lead);
  const g = s.frame.gutter;
  // True 200 ms in paper mode (the gutter widens to fit); capped in fit mode, which has no paper speed.
  // Fit mode keeps it right of the lead name (36 px) plus its 4 px baseline lead-in.
  const w = s.paper ? 0.2 * s.frame.pxPerSec : Math.min(0.2 * s.frame.pxPerSec, g - 48);
  const x0 = g - w - 8;
  const base = p.y + p.h / 2 + Math.min(h / 2, p.h / 2 - 2);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, s.paper ? s.frame.plot.y : p.y, g, s.paper ? s.frame.plot.h : p.h);
  ctx.clip();
  ctx.strokeStyle = c.dim;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x0 - 4, base);
  ctx.lineTo(x0, base);
  ctx.lineTo(x0, base - h);
  ctx.lineTo(x0 + w, base - h);
  ctx.lineTo(x0 + w, base);
  ctx.lineTo(x0 + w + 4, base);
  ctx.stroke();
  ctx.restore();
}

function drawRhythmTrack(ctx: CanvasRenderingContext2D, s: Scene, c: Colors) {
  const t = s.frame.track;
  const pps = s.frame.pxPerSec;
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.fillRect(t.x, t.y, t.w, t.h);
  ctx.strokeStyle = c.rule;
  ctx.beginPath();
  ctx.moveTo(t.x, t.y + 0.5);
  ctx.lineTo(t.x + t.w, t.y + 0.5);
  ctx.stroke();
  ctx.fillStyle = c.dim;
  ctx.font = "10px Inter, sans-serif";
  ctx.fillText(s.trackLabel, 6, t.y + 15);
  ctx.save();
  ctx.beginPath();
  ctx.rect(t.x, t.y, t.w, t.h);
  ctx.clip();
  const bar = (a: number, b: number, text: string, color: (alpha: number) => string, ai: boolean, sel: boolean) => {
    const x0 = xOf(t, pps, a);
    const x1 = xOf(t, pps, b);
    ctx.fillStyle = color(sel ? 0.55 : 0.32);
    ctx.fillRect(x0, t.y + 3, x1 - x0, t.h - 6);
    ctx.strokeStyle = ai ? c.ai : color(sel ? 1 : 0.8);
    ctx.lineWidth = sel ? 2 : 1;
    ctx.setLineDash(ai ? [4, 3] : []);
    ctx.strokeRect(x0 + 0.5, t.y + 3.5, x1 - x0 - 1, t.h - 7);
    ctx.setLineDash([]);
    ctx.fillStyle = "#fff";
    ctx.font = "600 10px Inter, sans-serif";
    ctx.fillText(text, Math.max(x0, t.x) + 4, t.y + 15);
    if (sel) {
      handleSquare(ctx, x0, t.y + t.h / 2, "#fff");
      handleSquare(ctx, x1, t.y + t.h / 2, "#fff");
    }
  };
  const codes = trackPalette(s.trackCodes);
  for (const a of s.anns) {
    if (kindOf(a) !== "rhythm") continue;
    const [start, end] = rangeOf(a.geometry)!;
    if (end < t.t0 || start > t.t1) continue;
    const code = rhythmOf(a);
    bar(start, end, code, (al) => resolveLabelColor(codes(code), code, al), a.provenance === "ai-suggested", s.selectedIds.has(a.id));
  }
  const d = s.draft;
  if (d?.kind === "rhythm") bar(Math.min(d.t0, d.t1), Math.max(d.t0, d.t1), d.rhythm, (al) => resolveLabelColor(codes(d.rhythm), d.rhythm, al * 0.8), false, false);
  ctx.restore();
}

/** Colour list for track codes: the vocabulary, plus codes it doesn't list, so each code keeps one colour. */
function trackPalette(vocab: string[]) {
  return (code: string) => (vocab.includes(code) ? vocab : [...vocab, code]);
}

function drawCaliper(ctx: CanvasRenderingContext2D, s: Scene, k: Caliper, c: Colors) {
  const { plot, pxPerSec } = s.frame;
  const p = k.panel;
  const x0 = xOf(p, pxPerSec, k.t0);
  const x1 = xOf(p, pxPerSec, k.t1);
  const color = k.qt ? c.warn : c.primary;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h + s.frame.track.h);
  ctx.clip();
  const dt = k.t1 - k.t0;
  if (s.marchOut && Math.abs(dt) > 0.05) {
    ctx.strokeStyle = resolveToken(k.qt ? "--chart-3" : "--primary", 0.5);
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let n = -40; n <= 40; n++) {
      if (n === 0 || n === 1) continue;
      const t = k.t0 + n * dt;
      if (t < p.t0 || t > p.t1) continue;
      const x = Math.round(xOf(p, pxPerSec, t)) + 0.5;
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const x of [x0, x1]) {
    ctx.moveTo(Math.round(x) + 0.5, plot.y);
    ctx.lineTo(Math.round(x) + 0.5, plot.y + plot.h);
  }
  ctx.moveTo(x0, k.y1);
  ctx.lineTo(x1, k.y1);
  ctx.stroke();
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(x0 - 8, k.y0);
  ctx.lineTo(x0 + 8, k.y0);
  ctx.moveTo(x1 - 8, k.y1);
  ctx.lineTo(x1 + 8, k.y1);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Readout box above the caliper, kept on screen.
  ctx.font = "600 11px Inter, sans-serif";
  const w = Math.max(...k.readout.map((l) => ctx.measureText(l).width)) + 12;
  const h = k.readout.length * 15 + 6;
  let bx = Math.max(x0, x1) + 8;
  if (bx + w > s.width - 4) bx = Math.min(x0, x1) - w - 8;
  bx = Math.max(s.frame.gutter, bx);
  const by = Math.max(plot.y + 18, Math.min(k.y1 - h - 6, plot.y + plot.h - h - 2));
  ctx.fillStyle = "rgba(0,0,0,0.78)";
  ctx.fillRect(bx, by, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
  ctx.fillStyle = "#fff";
  k.readout.forEach((l, i) => ctx.fillText(l, bx + 6, by + 15 + i * 15));
}

// ---------------------------------------------------------------- overview strip

export interface OverviewScene {
  width: number;
  height: number;
  signal: Float32Array | undefined;
  fs: number;
  duration: number;
  window: [number, number];
  anns: Annotation[];
  labels: string[];
  selectedId: string | null;
  /** Name of the channel shown. */
  channel: string;
  normalCode?: string;
  trackCodes: string[];
}

export function drawOverview(ctx: CanvasRenderingContext2D, o: OverviewScene) {
  const c = colors();
  ctx.clearRect(0, 0, o.width, o.height);
  const xOfT = (t: number) => GUTTER + (t / o.duration) * (o.width - GUTTER - 6);
  ctx.fillStyle = c.dim;
  ctx.font = "10px Inter, sans-serif";
  ctx.fillText(`${o.channel} · full`, 6, o.height / 2 + 4);
  const x = o.signal;
  if (x?.length) {
    // Robust vertical range: 1st–99th percentile of a subsample.
    const sub: number[] = [];
    const step = Math.max(1, Math.floor(x.length / 3000));
    for (let i = 0; i < x.length; i += step) sub.push(x[i]);
    sub.sort((a, b) => a - b);
    const lo = sub[Math.floor(sub.length * 0.01)];
    const hi = sub[Math.floor(sub.length * 0.99)];
    const pad = (hi - lo) * 0.15 || 1;
    const y = (v: number) => o.height - 7 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (o.height - 14);
    ctx.strokeStyle = c.dim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const w = o.width - GUTTER - 6;
    for (let px = 0; px < w; px++) {
      const i0 = Math.floor((px / w) * x.length);
      const i1 = Math.max(i0 + 1, Math.floor(((px + 1) / w) * x.length));
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = i0; i < i1 && i < x.length; i++) {
        mn = Math.min(mn, x[i]);
        mx = Math.max(mx, x[i]);
      }
      if (px === 0) ctx.moveTo(GUTTER, y(mx));
      ctx.lineTo(GUTTER + px, y(mx));
      ctx.lineTo(GUTTER + px, y(mn));
    }
    ctx.stroke();
  }
  const palette = trackPalette(o.trackCodes);
  for (const a of o.anns) {
    const k = kindOf(a);
    const r = rangeOf(a.geometry);
    if (!k || !r) continue;
    if (k === "rhythm") {
      const code = rhythmOf(a);
      ctx.fillStyle = resolveLabelColor(palette(code), code, 0.8);
      ctx.fillRect(xOfT(r[0]), 1, xOfT(r[1]) - xOfT(r[0]), 3);
    } else if (k === "beat") {
      ctx.fillStyle = a.id === o.selectedId ? c.primary : beatColor(o.labels, a, c, o.normalCode);
      ctx.fillRect(Math.round(xOfT(r[0])) - 0.5, o.height - 5, a.id === o.selectedId ? 3 : 1.5, 5);
    } else {
      const [a0, a1] = r;
      ctx.fillStyle = resolveLabelColor(o.labels, a.label, 0.35);
      ctx.fillRect(xOfT(a0), o.height - 9, Math.max(1, xOfT(a1) - xOfT(a0)), 3);
    }
  }
  const [w0, w1] = o.window;
  ctx.fillStyle = resolveToken("--primary", 0.16);
  ctx.fillRect(xOfT(w0), 0, xOfT(w1) - xOfT(w0), o.height);
  ctx.strokeStyle = resolveToken("--primary", 0.9);
  ctx.lineWidth = 1.5;
  ctx.strokeRect(xOfT(w0) + 0.75, 0.75, xOfT(w1) - xOfT(w0) - 1.5, o.height - 1.5);
}

export function overviewTimeAt(width: number, duration: number, x: number) {
  return ((x - GUTTER) / (width - GUTTER - 6)) * duration;
}
