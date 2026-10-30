import type { Annotation } from "@studio/plugin-contracts/types";
import type { StripChartConfig } from "../config";
import { snapToExtremum, wavePeak } from "../dsp";
import * as M from "../model";
import { drawOverview, drawScene, type Caliper, type Draft, type Scene } from "./draw";
import { leadLabelAt, panelAt, tOf, type Frame, type Panel, xOf } from "./layout";
import { isEditable, newAnnotation, useHost } from "@studio/plugin-ui-sdk";

/**
 * The strip chart's imperative core: pointer state machine (pan, create, edit, caliper,
 * rubber band), hit testing, shape edits and drawing. The React host owns data loading
 * and display settings, hands the engine a fresh `EngineState` every render and gets
 * changes back through `EngineHost` callbacks; annotations are written to the store.
 */

export type Handle = "move" | "start" | "end" | "peak";
type Host = Panel | Frame["track"];
type Drag =
  | { kind: "pan"; x0: number; offset0: number }
  | { kind: "overview" }
  | { kind: "create"; draft: Draft; panel: Host }
  | { kind: "caliper"; panel: Panel }
  | { kind: "band"; x0: number; y0: number; x1: number; y1: number; panel: Host }
  | { kind: "edit"; id: string; handle: Handle; orig: M.Shape; t0: number; panel: Host; preview: M.Shape; snapLead?: string };

export interface Hit {
  id: string;
  handle: Handle;
}

export interface EngineState {
  itemId: string;
  cfg: StripChartConfig;
  frame: Frame;
  width: number;
  height: number;
  fs: number;
  duration: number;
  /** Displayed (filtered) samples per channel. */
  leads: Record<string, Float32Array>;
  channels: string[];
  baseline: Record<string, number>;
  pxPerMvFor: (lead: string) => number;
  /** Visible annotations of the item. */
  anns: Annotation[];
  selectedId: string | null;
  selectedIds: Set<string>;
  labels: string[];
  activeLabel: string | null;
  tool: string;
  snap: boolean;
  paper: boolean;
  opacity: number;
  note: string;
  marchOut: boolean;
  focusLead?: string;
  caliper: Caliper | null;
  instantCode: string;
  trackCode: string;
  /** Primary channel (overview, the signal of "all"). */
  primary: string;
}

export interface EngineHost {
  redraw: () => void;
  scrollTo: (t0: number) => void;
  setCaliper: (c: Omit<Caliper, "readout"> | null | ((c: Omit<Caliper, "readout"> | null) => Omit<Caliper, "readout"> | null)) => void;
  openChannelMenu: (m: { lead: string; x: number; y: number } | null) => void;
  centre: (t: number) => void;
}

type Pt = { x: number; y: number };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class StripChartEngine {
  private drag: Drag | null = null;
  s!: EngineState;
  constructor(private host: EngineHost) {}

  update(s: EngineState) {
    this.s = s;
  }

  get busy() {
    return this.drag !== null;
  }

  /** Esc: drop a gesture in progress. */
  cancel(): boolean {
    if (!this.drag) return false;
    this.drag = null;
    this.host.redraw();
    return true;
  }

  /** Snap a time to the sample grid inside the record. */
  q = (t: number) => +(Math.round(clamp(t, 0, this.s.duration) * this.s.fs) / this.s.fs).toFixed(4);

  // ---------------------------------------------------------------- drawing

  scene(): Scene {
    const s = this.s;
    const d = this.drag;
    let anns = s.anns;
    if (d?.kind === "edit") anns = anns.map((a) => (a.id === d.id ? { ...a, ...d.preview } : a));
    return {
      width: s.width,
      height: s.height,
      frame: s.frame,
      fs: s.fs,
      leads: s.leads,
      baseline: s.baseline,
      pxPerMvFor: s.pxPerMvFor,
      anns,
      selectedId: s.selectedId,
      selectedIds: s.selectedIds,
      labels: s.labels,
      opacity: s.opacity,
      grid: s.cfg.grid,
      paper: s.paper,
      note: s.note,
      draft: d?.kind === "create" ? d.draft : null,
      caliper: s.caliper,
      marchOut: s.marchOut,
      focusLead: s.focusLead,
      band: d?.kind === "band" ? d : null,
      normalCode: s.cfg.instantCodes[0]?.id,
      trackCodes: s.cfg.trackCodes.map((c) => c.id),
      trackLabel: s.cfg.track.label,
    };
  }

  draw(main: CanvasRenderingContext2D | null | undefined, overview: CanvasRenderingContext2D | null | undefined, ov: { width: number; height: number }) {
    const s = this.s;
    const dpr = window.devicePixelRatio || 1;
    if (main && s.width) {
      main.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScene(main, this.scene());
    }
    if (overview && ov.width) {
      overview.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawOverview(overview, {
        width: ov.width,
        height: ov.height,
        signal: s.leads[s.primary] ?? s.leads[s.channels[0]],
        fs: s.fs,
        duration: s.duration,
        window: [s.frame.offset, s.frame.offset + s.frame.span],
        anns: s.anns,
        labels: s.labels,
        selectedId: s.selectedId,
        channel: s.leads[s.primary] ? s.primary : (s.channels[0] ?? ""),
        normalCode: s.cfg.instantCodes[0]?.id,
        trackCodes: s.cfg.trackCodes.map((c) => c.id),
      });
    }
  }

  // ---------------------------------------------------------------- hit testing

  inTrack(x: number, y: number) {
    const t = this.s.frame.track;
    return x >= t.x && y >= t.y && y < t.y + t.h;
  }

  hitTest(x: number, y: number): Hit | null {
    const { frame, anns, selectedId } = this.s;
    const pps = frame.pxPerSec;
    const cands: { hit: Hit; d: number }[] = [];
    if (this.inTrack(x, y)) {
      for (const a of anns) {
        if (M.kindOf(a) !== "rhythm") continue;
        const [s0, s1] = M.rangeOf(a.geometry)!;
        const x0 = xOf(frame.track, pps, s0);
        const x1 = xOf(frame.track, pps, s1);
        if (Math.abs(x - x0) < 6) cands.push({ hit: { id: a.id, handle: "start" }, d: Math.abs(x - x0) });
        else if (Math.abs(x - x1) < 6) cands.push({ hit: { id: a.id, handle: "end" }, d: Math.abs(x - x1) });
        else if (x > x0 && x < x1) cands.push({ hit: { id: a.id, handle: "move" }, d: 10 });
      }
    }
    const p = panelAt(frame, x, y);
    if (p) {
      for (const a of anns) {
        const k = M.kindOf(a);
        const lead = M.channelOf(a.geometry);
        if (!k || k === "rhythm" || (lead !== "all" && lead !== p.lead)) continue;
        const sel = a.id === selectedId ? -2 : 0;
        const [s0, s1] = M.rangeOf(a.geometry)!;
        if (k === "beat") {
          const dx = Math.abs(x - xOf(p, pps, s0));
          if (dx < 6) cands.push({ hit: { id: a.id, handle: "move" }, d: dx + sel - 1 });
          continue;
        }
        const x0 = xOf(p, pps, s0);
        const x1 = xOf(p, pps, s1);
        const peak = k === "wave" ? M.peakOf(a) : undefined;
        if (peak !== undefined && a.id === selectedId) {
          const dp = Math.abs(x - xOf(p, pps, peak));
          if (dp < 6 && y < p.y + 18) cands.push({ hit: { id: a.id, handle: "peak" }, d: dp - 3 });
        }
        if (Math.abs(x - x0) < 5) cands.push({ hit: { id: a.id, handle: "start" }, d: Math.abs(x - x0) + sel });
        else if (Math.abs(x - x1) < 5) cands.push({ hit: { id: a.id, handle: "end" }, d: Math.abs(x - x1) + sel });
        else if (x > x0 && x < x1) cands.push({ hit: { id: a.id, handle: "move" }, d: 8 + sel + Math.min(20, (x1 - x0) / 50) });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    return cands[0]?.hit ?? null;
  }

  /** The edited shape for a drag of `handle` to time `t`. */
  editShape(d: Extract<Drag, { kind: "edit" }>, t: number): M.Shape {
    const { geometry: g, attributes } = d.orig;
    const { q } = this;
    const dt = t - d.t0;
    const sig = d.snapLead ? this.s.leads[d.snapLead] : undefined;
    const snap = (v: number) => (this.s.snap && sig ? snapToExtremum(sig, this.s.fs, v, 0.05) : v);
    const shift = (a: number, b: number) => {
      const s = clamp(dt, -a, this.s.duration - b);
      return [q(a + s), q(b + s)] as const;
    };
    const kind = M.kindOf(d.orig);
    if (g.type === "instant") return { geometry: { ...g, t: q(snap(t)) }, attributes };
    if (g.type !== "span") return d.orig;
    if (kind !== "wave") {
      if (d.handle === "move") {
        const [start, end] = shift(g.start, g.end);
        return { geometry: { ...g, start, end }, attributes };
      }
      const a = d.handle === "start" ? t : g.start;
      const b = d.handle === "end" ? t : g.end;
      return { geometry: { ...g, start: q(Math.min(a, b)), end: q(Math.max(a, b)) }, attributes };
    }
    const peak = M.peakOf(d.orig);
    if (d.handle === "move") {
      const [start, end] = shift(g.start, g.end);
      return { geometry: { ...g, start, end }, attributes: M.withPeak(attributes, peak === undefined ? undefined : q(peak + (start - g.start))) };
    }
    if (d.handle === "peak") return { geometry: g, attributes: M.withPeak(attributes, q(clamp(t, g.start, g.end))) };
    const a = d.handle === "start" ? t : g.start;
    const b = d.handle === "end" ? t : g.end;
    const start = q(Math.min(a, b));
    const end = q(Math.max(a, b));
    return { geometry: { ...g, start, end }, attributes: M.withPeak(attributes, peak === undefined ? undefined : q(clamp(peak, start, end))) };
  }

  /** Annotations inside a rubber band: each channel strip (and the track) it crosses, over the time it covers there. */
  bandHits(b: { x0: number; y0: number; x1: number; y1: number }): string[] {
    const { frame, anns } = this.s;
    const [xa, xb, ya, yb] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1), Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
    const pps = frame.pxPerSec;
    const ranges: { lead: string | null; t0: number; t1: number }[] = [];
    const cover = (r: { x: number; y: number; w: number; h: number; t0: number }, lead: string | null) => {
      if (xb < r.x || xa > r.x + r.w || yb < r.y || ya > r.y + r.h) return;
      ranges.push({ lead, t0: tOf(r, pps, Math.max(xa, r.x)), t1: tOf(r, pps, Math.min(xb, r.x + r.w)) });
    };
    frame.panels.forEach((p) => cover(p, p.lead));
    cover(frame.track, null);
    const ids: string[] = [];
    for (const a of anns) {
      const k = M.kindOf(a);
      const span = M.rangeOf(a.geometry);
      if (!k || !span) continue;
      const lead = k === "rhythm" ? null : M.channelOf(a.geometry);
      const hit = ranges.some((r) => (lead === null ? r.lead === null : r.lead !== null && (lead === "all" || lead === r.lead)) && span[1] >= r.t0 && span[0] <= r.t1);
      if (hit) ids.push(a.id);
    }
    return ids;
  }

  // ---------------------------------------------------------------- labels for new shapes

  /** Label class of a new instant: the configured one if the env has it, else the active label. */
  instantLabel(): string {
    const { cfg, labels, activeLabel } = this.s;
    if (cfg.instantLabel && labels.includes(cfg.instantLabel)) return cfg.instantLabel;
    const wave = cfg.waves.find((w) => w.id === cfg.defaultWave)?.label;
    return (wave && labels.includes(wave) ? wave : undefined) ?? activeLabel ?? labels[0] ?? "instant";
  }

  /** Wave name for the active label, and the label the new wave gets. */
  waveFor(activeLabel: string): { wave: string; label: string } {
    const { cfg, labels } = this.s;
    const own = cfg.waves.find((w) => w.label === activeLabel);
    if (own) return { wave: own.id, label: activeLabel };
    const wave = cfg.defaultWave ?? activeLabel;
    const lbl = cfg.waves.find((w) => w.id === wave)?.label;
    return { wave, label: lbl && labels.includes(lbl) ? lbl : activeLabel };
  }

  /** Signal a shape on `lead` is measured on ("all" → the primary channel). */
  signalFor(lead: string) {
    const { leads, primary, channels } = this.s;
    return leads[lead === "all" ? (leads[primary] ? primary : channels[0]) : lead];
  }

  // ---------------------------------------------------------------- pointer

  pointerDown(e: PointerEvent, el: HTMLElement, { x, y }: Pt) {
    const s = this.s;
    const { frame, tool, duration } = s;
    this.host.openChannelMenu(null);
    const capture = () => el.setPointerCapture(e.pointerId);
    const st = useHost.getState();
    if (e.button === 1 || tool === "pan") {
      this.drag = { kind: "pan", x0: x, offset0: frame.offset };
      capture();
      return;
    }
    if (e.button !== 0) return;
    const label = leadLabelAt(frame, x, y);
    if (label && (tool === "select" || x < frame.gutter)) {
      this.host.openChannelMenu({ lead: label.lead, x: Math.min(x, s.width - 190), y });
      return;
    }
    const p = panelAt(frame, x, y);
    const host: Host | undefined = p ?? (this.inTrack(x, y) ? frame.track : undefined);
    const t = host ? clamp(tOf(host, frame.pxPerSec, x), 0, duration) : 0;

    const startEdit = (hit: Hit) => {
      st.select(hit.id);
      const a = s.anns.find((x) => x.id === hit.id)!;
      if (!isEditable(a, st.lockedLabels) || !host) return;
      const shape: M.Shape = { geometry: a.geometry, attributes: a.attributes ?? {} };
      const lead = M.channelOf(a.geometry);
      const snapLead = M.kindOf(a) === "beat" ? (lead === "all" ? p?.lead : lead) : undefined;
      this.drag = { kind: "edit", id: a.id, handle: hit.handle, orig: shape, t0: t, panel: host, preview: shape, snapLead };
      capture();
    };

    switch (tool) {
      case "select": {
        const hit = this.hitTest(x, y);
        if (hit && e.shiftKey) st.toggleSelect(hit.id);
        else if (hit) startEdit(hit);
        else if (e.shiftKey && host) {
          // Shift-drag on empty plot: rubber-band selection over a time range and the channels it covers.
          this.drag = { kind: "band", x0: x, y0: y, x1: x, y1: y, panel: host };
          capture();
        } else {
          st.select(null);
          this.drag = { kind: "pan", x0: x, offset0: frame.offset };
          capture();
        }
        return;
      }
      case "beat": {
        if (!p) return;
        const hit = this.hitTest(x, y);
        if (hit && M.kindOf(s.anns.find((a) => a.id === hit.id)!) === "beat") return startEdit(hit);
        const sig = s.leads[p.lead];
        const tt = this.q(s.snap && sig ? snapToExtremum(sig, s.fs, t, 0.05) : t);
        const a = newAnnotation({ itemId: s.itemId, label: this.instantLabel(), ...M.beat(e.shiftKey ? "all" : p.lead, tt, s.instantCode) });
        st.add(a);
        st.select(a.id);
        return;
      }
      case "interval":
      case "wave": {
        if (!p || !s.activeLabel) return;
        const { wave, label: lbl } = tool === "wave" ? this.waveFor(s.activeLabel) : { wave: undefined, label: s.activeLabel };
        this.drag = { kind: "create", panel: p, draft: { kind: tool, lead: e.shiftKey ? "all" : p.lead, t0: t, t1: t, label: lbl, wave } };
        capture();
        return;
      }
      case "rhythm": {
        if (!host) return;
        this.drag = { kind: "create", panel: host, draft: { kind: "rhythm", t0: t, t1: t, rhythm: s.trackCode } };
        capture();
        return;
      }
      case "caliper": {
        if (!p) return;
        this.host.setCaliper({ t0: t, t1: t, y0: y, y1: y, panel: p, qt: e.altKey && s.cfg.ecg });
        this.drag = { kind: "caliper", panel: p };
        capture();
        return;
      }
    }
  }

  pointerMove(_e: PointerEvent, el: HTMLElement, { x, y }: Pt) {
    const d = this.drag;
    const { frame, duration, tool } = this.s;
    if (!d) {
      // Hover cursor feedback for the select tool.
      if (tool === "select") {
        const onLabel = leadLabelAt(frame, x, y);
        const hit = onLabel ? null : this.hitTest(x, y);
        el.style.cursor = onLabel ? "pointer" : hit ? (hit.handle === "move" ? "move" : "ew-resize") : "grab";
      }
      return;
    }
    const tAt = (h: Host) => clamp(tOf(h, frame.pxPerSec, x), 0, duration);
    switch (d.kind) {
      case "pan":
        this.host.scrollTo(d.offset0 - (x - d.x0) / frame.pxPerSec);
        return;
      case "caliper": {
        const t = tAt(d.panel);
        this.host.setCaliper((c) => (c ? { ...c, t1: t, y1: y } : c));
        return;
      }
      case "create":
        d.draft.t1 = tAt(d.panel);
        this.host.redraw();
        return;
      case "edit":
        d.preview = this.editShape(d, tAt(d.panel));
        this.host.redraw();
        return;
      case "band":
        d.x1 = x;
        d.y1 = y;
        this.host.redraw();
        return;
    }
  }

  pointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const s = this.s;
    const st = useHost.getState();
    if (d.kind === "create") {
      const a = this.q(Math.min(d.draft.t0, d.draft.t1));
      const b = this.q(Math.max(d.draft.t0, d.draft.t1));
      const dr = d.draft;
      let ann: Annotation | null = null;
      if (dr.kind === "interval" && b - a >= 0.01) {
        ann = newAnnotation({ itemId: s.itemId, label: dr.label, ...M.interval(dr.lead, a, b) });
      } else if (dr.kind === "wave" && b - a >= 0.01) {
        const sig = this.signalFor(dr.lead);
        const peak = sig ? this.q(wavePeak(sig, s.fs, a, b)) : undefined;
        ann = newAnnotation({ itemId: s.itemId, label: dr.label, ...M.wave(dr.lead, dr.wave ?? "", a, b, peak) });
      } else if (dr.kind === "rhythm" && b - a >= 0.05) {
        ann = newAnnotation({ itemId: s.itemId, label: dr.rhythm, ...M.rhythm(s.cfg.track.channel, a, b, dr.rhythm) });
      }
      if (ann) {
        st.add(ann);
        st.select(ann.id);
      } else this.host.redraw();
    } else if (d.kind === "edit") {
      if (JSON.stringify(d.preview) !== JSON.stringify(d.orig)) st.update(d.id, { geometry: d.preview.geometry, attributes: d.preview.attributes });
      else this.host.redraw();
    } else if (d.kind === "band") {
      const ids = this.bandHits(d);
      // Shift-band adds to the existing selection.
      st.selectMany([...new Set([...st.selectedIds.filter((id) => s.anns.some((a) => a.id === id)), ...ids])]);
      this.host.redraw();
    }
  }

  /** Overview strip: click or drag to move the window. */
  overview(e: PointerEvent, el: HTMLElement, toTime: (x: number) => number) {
    if (e.type === "pointerdown") {
      el.setPointerCapture(e.pointerId);
      this.drag = { kind: "overview" };
    } else if (this.drag?.kind !== "overview") return;
    const r = el.getBoundingClientRect();
    this.host.centre(toTime(e.clientX - r.left));
  }

  endOverview() {
    if (this.drag?.kind === "overview") this.drag = null;
  }
}

// ---------------------------------------------------------------- suggestion review

/**
 * The next unreviewed suggestion in time order after (dir 1) or before (−1) `cur`, wrapping;
 * from no selection, the first after the window start (or last before its end).
 */
export function nextSuggestion(review: Annotation[], cur: Annotation | null | undefined, dir: 1 | -1, window: [number, number]): Annotation | undefined {
  if (!review.length) return undefined;
  const at = (a: Annotation) => M.timeOf(a.geometry)!;
  const idx = cur ? review.findIndex((a) => a.id === cur.id) : -1;
  let next: Annotation | undefined;
  if (idx >= 0) next = review[idx + dir];
  else {
    const t = cur ? (M.timeOf(cur.geometry) ?? window[0]) : dir > 0 ? window[0] - 1e-6 : window[1];
    next = dir > 0 ? review.find((a) => at(a) > t) : [...review].reverse().find((a) => at(a) < t);
  }
  next ??= dir > 0 ? review.find((a) => a.id !== cur?.id) : [...review].reverse().find((a) => a.id !== cur?.id);
  return next;
}

/** Codes of the selected, editable instants set in one undo step; false when none is selected. */
export function setCodeOfSelected(itemId: string, code: string): boolean {
  const s = useHost.getState();
  const beats = s.annotations.filter((a) => a.itemId === itemId && s.selectedIds.includes(a.id) && M.kindOf(a) === "beat" && isEditable(a, s.lockedLabels));
  if (!beats.length) return false;
  // The code is the annotation's content, so changing it corrects an AI suggestion.
  s.batch({ update: beats.map((a) => ({ id: a.id, patch: { attributes: { ...a.attributes, code }, provenance: a.provenance === "ai-suggested" ? ("human-corrected" as const) : a.provenance } })) });
  return true;
}
