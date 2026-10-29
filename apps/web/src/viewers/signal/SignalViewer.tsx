import { labelNames } from "@/platform/environment";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CardiacIcon as HeartPulse, SpinnerIcon as Loader2, SidePanelIcon as PanelRight } from "@/components/icons";
import { useCommands } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { BarPick, BarSegmented, BarToggle } from "@/kits/viewport-chrome/controls";
import { isEditable, newAnnotation, useStudio, visibleFor } from "@/stores/studio";
import type { Annotation, Geometry } from "@/types";
import { CanvasNotice } from "@/kits/viewport-chrome/CanvasNotice";
import { useCanvasSize } from "@/kits/viewport-chrome/useCanvasSize";
import type { ViewerProps } from "@/viewers/ViewerAdapter";
import { BEAT_CODES, beatCodeName, labelForWave, RHYTHMS, SHIFT_BEAT_CODES, waveKindForLabel } from "./codes";
import { isPassthrough, snapToExtremum, wavePeak, type FilterConfig } from "./dsp";
import { detectBeats, filteredLeads } from "./dspClient";
import { computeFrame, leadLabelAt, panelAt, tOf, type Frame, type LayoutMode, type Panel, type ScaleMode, xOf } from "./layout";
import { bazett, beatTimes, fridericia, measure, rrAround, timeOf } from "./measure";
import { loadRecording, median, type Recording } from "./record";
import { drawOverview, drawScene, overviewTimeAt, type Caliper, type Draft } from "./render";
import { SidePanel } from "./SidePanel";
import { CalibrateDialog } from "./CalibrateDialog";
import { useScreenScale } from "./calibration";

// ------------------------------------------------------------------ display settings

interface Display {
  layout: LayoutMode;
  /** Layout to return to when leaving single-lead focus. */
  prevLayout: Exclude<LayoutMode, "single">;
  focus: string;
  scale: ScaleMode;
  speed: number;
  gain: number;
  /** Per-lead gain override, mm/mV. */
  leadGain: Record<string, number>;
  hp: number;
  notch: number;
  lp: number;
  snap: boolean;
  marchOut: boolean;
  panel: boolean;
}

const DEFAULT_DISPLAY: Display = {
  layout: "12x1",
  prevLayout: "12x1",
  focus: "II",
  scale: "fit",
  speed: 25,
  gain: 10,
  leadGain: {},
  // AHA diagnostic bandwidth by default: nearly raw, without the baseline offset.
  hp: 0.05,
  notch: 0,
  lp: 150,
  snap: true,
  marchOut: false,
  panel: true,
};

const STORAGE_KEY = "inkling.signal.display.v1";

function useDisplay() {
  const [d, setD] = useState<Display>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...DEFAULT_DISPLAY, ...(JSON.parse(raw) as Partial<Display>) } : DEFAULT_DISPLAY;
    } catch {
      return DEFAULT_DISPLAY;
    }
  });
  const set = useCallback((patch: Partial<Display>) => {
    setD((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable: settings last for the session only
      }
      return next;
    });
  }, []);
  return [d, set] as const;
}

const WINDOWS = [10, 5, 2.5, 1];
const SPEEDS = [12.5, 25, 50, 100];
const GAINS = [5, 10, 20];
const HP = [0, 0.05, 0.5];
const NOTCH = [0, 50, 60];
const LP = [0, 40, 100, 150];
const LAYOUTS: { v: LayoutMode; label: string; title: string }[] = [
  { v: "12x1", label: "12×1", title: "Twelve stacked leads (annotation view)" },
  { v: "6x2", label: "6×2", title: "Limb leads | chest leads, consecutive time" },
  { v: "3x4", label: "3×4", title: "Standard 3×4 + lead II rhythm strip, 2.5 s per column" },
  { v: "single", label: "1", title: "Single-lead focus (click a lead name)" },
];

export function filterText(c: FilterConfig): string {
  if (isPassthrough(c)) return "unfiltered";
  const band = `${c.hp || "DC"}–${c.lp || "∞"} Hz`;
  return c.notch ? `${band} · ${c.notch} Hz notch` : band;
}

// ------------------------------------------------------------------ interaction state

type Handle = "move" | "start" | "end" | "onset" | "offset" | "peak";
type Drag =
  | { kind: "pan"; x0: number; offset0: number }
  | { kind: "overview" }
  | { kind: "create"; draft: Draft; panel: Panel | Frame["track"] }
  | { kind: "caliper"; panel: Panel }
  | { kind: "band"; x0: number; y0: number; x1: number; y1: number; panel: Panel | Frame["track"] }
  | { kind: "edit"; id: string; handle: Handle; orig: Geometry; t0: number; panel: Panel | Frame["track"]; preview: Geometry; snapLead?: string };

interface Hit {
  id: string;
  handle: Handle;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function SignalViewer({ project, item }: ViewerProps) {
  const labels = useMemo(() => labelNames(project.labels), [project.labels]);
  const main = useCanvasSize();
  const ov = useCanvasSize();
  const size = main.size;
  const [rec, setRec] = useState<Recording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [display, setDisplay] = useDisplay();
  const [windowSec, setWindowSec] = useState(10);
  const [offset, setOffset] = useState(0);
  const [filtered, setFiltered] = useState<{ key: string; leads: Record<string, Float32Array> } | null>(null);
  const [beatCode, setBeatCode] = useState("N");
  const [rhythmCode, setRhythmCode] = useState("(N");
  const [caliper, setCaliper] = useState<Omit<Caliper, "readout"> | null>(null);
  const [leadMenu, setLeadMenu] = useState<{ lead: string; x: number; y: number } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const tool = useStudio((s) => s.tool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const annotations = useStudio((s) => s.annotations);
  const selectedId = useStudio((s) => s.selectedId);
  const selectedIds = useStudio((s) => s.selectedIds);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const screen = useScreenScale();
  const [calibrating, setCalibrating] = useState(false);
  const hiddenLabels = useStudio((s) => s.hiddenLabels);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const overlayOpacity = useStudio((s) => s.overlayOpacity);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);

  // ---------------------------------------------------------------- data
  useEffect(() => {
    const ctl = new AbortController();
    setRec(null);
    setError(null);
    setOffset(0);
    setCaliper(null);
    loadRecording(item, ctl.signal)
      .then(setRec)
      .catch((e) => !ctl.signal.aborted && setError(e instanceof Error && e.message === "404" ? "Recording not found." : "This recording could not be loaded."));
    return () => ctl.abort();
  }, [item]);

  const filterCfg = useMemo<FilterConfig>(() => ({ hp: display.hp, notch: display.notch, lp: display.lp }), [display.hp, display.notch, display.lp]);
  const wantKey = rec ? `${rec.record}|${filterText(filterCfg)}` : "";
  useEffect(() => {
    if (!rec) return;
    let live = true;
    const key = `${rec.record}|${filterText(filterCfg)}`;
    filteredLeads(rec.record, rec.fs, rec.leads, filterCfg).then((leads) => live && setFiltered({ key, leads }));
    return () => {
      live = false;
    };
  }, [rec, filterCfg]);
  const filterPending = !!rec && filtered?.key !== wantKey;
  // Keep showing the previous filter output of the same record while the new one computes.
  const leads = rec && filtered?.key.startsWith(`${rec.record}|`) ? filtered.leads : rec?.leads ?? {};
  const baseline = useMemo(() => Object.fromEntries(Object.entries(leads).map(([k, v]) => [k, median(v)])), [leads]);

  const fs = rec?.fs ?? 500;
  const duration = rec ? rec.samples / rec.fs : 10;
  const leadNames = rec?.leadNames ?? [];

  const frame = useMemo(
    () =>
      computeFrame({
        width: size.width,
        height: size.height,
        leads: leadNames.length ? leadNames : ["II"],
        mode: display.layout,
        focus: display.focus,
        scale: display.scale,
        speed: display.speed,
        gain: display.gain,
        windowSec,
        offset,
        duration,
        pxPerMm: screen.pxPerMm,
      }),
    [size.width, size.height, leadNames, display.layout, display.focus, display.scale, display.speed, display.gain, windowSec, offset, duration, screen.pxPerMm],
  );
  const span = frame.span;
  const pxPerMvFor = useCallback((lead: string) => frame.pxPerMv * ((display.leadGain[lead] ?? display.gain) / display.gain), [frame.pxPerMv, display.leadGain, display.gain]);
  const q = useCallback((t: number) => +(Math.round(clamp(t, 0, duration) * fs) / fs).toFixed(4), [fs, duration]);

  const mineAll = useMemo(() => annotations.filter((a) => a.itemId === item.id), [annotations, item.id]);
  const mine = useMemo(() => visibleFor(annotations, item.id, hiddenLabels), [annotations, item.id, hiddenLabels]);
  const m = useMemo(() => measure(mine), [mine]);
  const times = useMemo(() => beatTimes(mine), [mine]);
  const selected = mineAll.find((a) => a.id === selectedId) ?? null;

  const scrollTo = useCallback((t0: number) => setOffset(clamp(t0, 0, Math.max(0, duration - span))), [duration, span]);
  const centre = useCallback((t: number) => scrollTo(t - span / 2), [scrollTo, span]);

  // Bring a selection made elsewhere (sidebar list, review) into view.
  useEffect(() => {
    if (!selected) return;
    const t0 = timeOf(selected.geometry);
    if (t0 === undefined) return;
    if (t0 < frame.offset || t0 > frame.offset + span) centre(t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // ---------------------------------------------------------------- status
  useEffect(() => {
    if (!rec) return;
    const scale = display.scale === "paper" ? `${display.speed} mm/s · ${display.gain} mm/mV` : `fit · ${display.gain} mm/mV`;
    const hr = m.hr ? ` · HR ${Math.round(m.hr)} bpm` : "";
    setViewerStatus(`${rec.fs} Hz · ${leadNames.length} leads · ${frame.offset.toFixed(2)}–${(frame.offset + span).toFixed(2)} s of ${duration.toFixed(0)} s · ${scale} · ${filterText(filterCfg)}${hr}`);
  }, [rec, leadNames.length, frame.offset, span, duration, display.scale, display.speed, display.gain, filterCfg, m.hr, setViewerStatus]);

  // ---------------------------------------------------------------- caliper readout
  const caliperFull = useMemo<Caliper | null>(() => {
    if (!caliper) return null;
    const dt = Math.abs(caliper.t1 - caliper.t0);
    const lines: string[] = [];
    if (caliper.qt) {
      const rr = rrAround(times, Math.min(caliper.t0, caliper.t1));
      lines.push(`QT ${Math.round(dt * 1000)} ms`);
      if (rr) {
        lines.push(`RR ${Math.round(rr * 1000)} ms (${Math.round(60 / rr)} bpm)`);
        lines.push(`QTc Bazett ${Math.round(bazett(dt, rr) * 1000)} ms`);
        lines.push(`QTc Fridericia ${Math.round(fridericia(dt, rr) * 1000)} ms`);
      } else lines.push("QTc: mark or detect beats for RR");
    } else {
      const dmv = (caliper.y0 - caliper.y1) / pxPerMvFor(caliper.panel.lead);
      lines.push(`Δt ${Math.round(dt * 1000)} ms`);
      if (dt > 0.05) lines.push(`${(60 / dt).toFixed(0)} bpm`);
      lines.push(`ΔV ${dmv >= 0 ? "+" : ""}${dmv.toFixed(2)} mV`);
    }
    return { ...caliper, readout: lines };
  }, [caliper, times, pxPerMvFor]);

  // ---------------------------------------------------------------- drawing
  const scene = () => {
    const d = drag.current;
    let anns = mine;
    if (d?.kind === "edit") anns = mine.map((a) => (a.id === d.id ? { ...a, geometry: d.preview } : a));
    return {
      width: size.width,
      height: size.height,
      frame,
      fs,
      leads,
      baseline,
      pxPerMvFor,
      anns,
      selectedId,
      selectedIds: selectedSet,
      labels,
      opacity: overlayOpacity,
      paper: display.scale === "paper",
      note: `${display.scale === "paper" ? `${display.speed} mm/s · ` : ""}${display.gain} mm/mV · ${filterText(filterCfg)}`,
      draft: d?.kind === "create" ? d.draft : null,
      caliper: caliperFull,
      marchOut: display.marchOut,
      focusLead: display.layout === "single" ? display.focus : undefined,
      band: d?.kind === "band" ? d : null,
    };
  };

  useEffect(() => {
    const ctx = main.canvasRef.current?.getContext("2d");
    if (!ctx || !size.width || !rec) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene(ctx, scene());
  });

  useEffect(() => {
    const ctx = ov.canvasRef.current?.getContext("2d");
    if (!ctx || !ov.size.width || !rec) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverview(ctx, {
      width: ov.size.width,
      height: ov.size.height,
      signal: leads.II ?? leads[leadNames[0]],
      fs,
      duration,
      window: [frame.offset, frame.offset + span],
      anns: mine,
      labels,
      selectedId,
    });
  });

  // ---------------------------------------------------------------- hit testing
  const pos = (e: { clientX: number; clientY: number }) => {
    const r = main.canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const inTrack = (x: number, y: number) => x >= frame.track.x && y >= frame.track.y && y < frame.track.y + frame.track.h;

  const hitTest = (x: number, y: number): Hit | null => {
    const pps = frame.pxPerSec;
    const cands: { hit: Hit; d: number }[] = [];
    if (inTrack(x, y)) {
      for (const a of mine) {
        const g = a.geometry;
        if (g.type !== "rhythm") continue;
        const x0 = xOf(frame.track, pps, g.start);
        const x1 = xOf(frame.track, pps, g.end);
        if (Math.abs(x - x0) < 6) cands.push({ hit: { id: a.id, handle: "start" }, d: Math.abs(x - x0) });
        else if (Math.abs(x - x1) < 6) cands.push({ hit: { id: a.id, handle: "end" }, d: Math.abs(x - x1) });
        else if (x > x0 && x < x1) cands.push({ hit: { id: a.id, handle: "move" }, d: 10 });
      }
    }
    const p = panelAt(frame, x, y);
    if (p) {
      for (const a of mine) {
        const g = a.geometry;
        const sel = a.id === selectedId ? -2 : 0;
        if (g.type === "beat" && (g.lead === "all" || g.lead === p.lead)) {
          const dx = Math.abs(x - xOf(p, pps, g.t));
          if (dx < 6) cands.push({ hit: { id: a.id, handle: "move" }, d: dx + sel - 1 });
        } else if ((g.type === "wave" || g.type === "interval") && (g.lead === "all" || g.lead === p.lead)) {
          const [s0, s1, k0, k1]: [number, number, Handle, Handle] = g.type === "wave" ? [g.onset, g.offset, "onset", "offset"] : [g.start, g.end, "start", "end"];
          const x0 = xOf(p, pps, s0);
          const x1 = xOf(p, pps, s1);
          if (g.type === "wave" && g.peak !== undefined && a.id === selectedId) {
            const dp = Math.abs(x - xOf(p, pps, g.peak));
            if (dp < 6 && y < p.y + 18) cands.push({ hit: { id: a.id, handle: "peak" }, d: dp - 3 });
          }
          if (Math.abs(x - x0) < 5) cands.push({ hit: { id: a.id, handle: k0 }, d: Math.abs(x - x0) + sel });
          else if (Math.abs(x - x1) < 5) cands.push({ hit: { id: a.id, handle: k1 }, d: Math.abs(x - x1) + sel });
          else if (x > x0 && x < x1) cands.push({ hit: { id: a.id, handle: "move" }, d: 8 + sel + Math.min(20, (x1 - x0) / 50) });
        }
      }
    }
    cands.sort((a, b) => a.d - b.d);
    return cands[0]?.hit ?? null;
  };

  const editGeometry = (d: Extract<Drag, { kind: "edit" }>, t: number): Geometry => {
    const g = d.orig;
    const dt = t - d.t0;
    const sig = d.snapLead ? leads[d.snapLead] : undefined;
    const snap = (v: number) => (display.snap && sig ? snapToExtremum(sig, fs, v, 0.05) : v);
    const shift = (a: number, b: number) => {
      const s = clamp(dt, -a, duration - b);
      return [q(a + s), q(b + s)] as const;
    };
    switch (g.type) {
      case "beat":
        return { ...g, t: q(snap(t)) };
      case "interval":
      case "rhythm": {
        if (d.handle === "move") {
          const [start, end] = shift(g.start, g.end);
          return { ...g, start, end };
        }
        const a = d.handle === "start" ? t : g.start;
        const b = d.handle === "end" ? t : g.end;
        return { ...g, start: q(Math.min(a, b)), end: q(Math.max(a, b)) };
      }
      case "wave": {
        if (d.handle === "move") {
          const [onset, offset] = shift(g.onset, g.offset);
          return { ...g, onset, offset, peak: g.peak === undefined ? undefined : q(g.peak + (onset - g.onset)) };
        }
        if (d.handle === "peak") return { ...g, peak: q(clamp(t, g.onset, g.offset)) };
        const a = d.handle === "onset" ? t : g.onset;
        const b = d.handle === "offset" ? t : g.offset;
        const onset = q(Math.min(a, b));
        const offset = q(Math.max(a, b));
        return { ...g, onset, offset, peak: g.peak === undefined ? undefined : q(clamp(g.peak, onset, offset)) };
      }
      default:
        return g;
    }
  };

  // ---------------------------------------------------------------- pointer
  const signalFor = (lead: string) => leads[lead === "all" ? (leads.II ? "II" : leadNames[0]) : lead];

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!rec) return;
    setLeadMenu(null);
    const { x, y } = pos(e);
    const capture = () => e.currentTarget.setPointerCapture(e.pointerId);
    const s = useStudio.getState();
    if (e.button === 1 || tool === "pan") {
      drag.current = { kind: "pan", x0: x, offset0: frame.offset };
      capture();
      return;
    }
    if (e.button !== 0) return;
    const label = leadLabelAt(frame, x, y);
    if (label && (tool === "select" || x < frame.gutter)) {
      setLeadMenu({ lead: label.lead, x: Math.min(x, size.width - 190), y });
      return;
    }
    const p = panelAt(frame, x, y);
    const track = inTrack(x, y);
    const host: Panel | Frame["track"] | undefined = p ?? (track ? frame.track : undefined);
    const t = host ? clamp(tOf(host, frame.pxPerSec, x), 0, duration) : 0;

    const startEdit = (hit: Hit) => {
      s.select(hit.id);
      const a = mine.find((x) => x.id === hit.id)!;
      if (!isEditable(a, s.lockedLabels) || !host) return;
      const lead = "lead" in a.geometry ? (a.geometry.lead as string) : undefined;
      drag.current = { kind: "edit", id: a.id, handle: hit.handle, orig: a.geometry, t0: t, panel: host, preview: a.geometry, snapLead: lead && a.geometry.type === "beat" ? (lead === "all" ? p?.lead : lead) : undefined };
      capture();
    };

    switch (tool) {
      case "select": {
        const hit = hitTest(x, y);
        if (hit && e.shiftKey) s.toggleSelect(hit.id);
        else if (hit) startEdit(hit);
        else if (e.shiftKey && host) {
          // Shift-drag on empty plot: rubber-band selection over a time range and the leads it covers.
          drag.current = { kind: "band", x0: x, y0: y, x1: x, y1: y, panel: host };
          capture();
        } else {
          s.select(null);
          drag.current = { kind: "pan", x0: x, offset0: frame.offset };
          capture();
        }
        return;
      }
      case "beat": {
        if (!p) return;
        const hit = hitTest(x, y);
        if (hit && mine.find((a) => a.id === hit.id)?.geometry.type === "beat") return startEdit(hit);
        const sig = leads[p.lead];
        const tt = q(display.snap && sig ? snapToExtremum(sig, fs, t, 0.05) : t);
        const beatLabel = labels.includes("QRS complex") ? "QRS complex" : labelForWave(labels, "QRS") ?? activeLabel ?? labels[0] ?? "beat";
        const a = newAnnotation({ itemId: item.id, label: beatLabel, geometry: { type: "beat", lead: e.shiftKey ? "all" : p.lead, t: tt, code: beatCode } });
        s.add(a);
        s.select(a.id);
        return;
      }
      case "interval":
      case "wave": {
        if (!p || !activeLabel) return;
        const wave = tool === "wave" ? waveKindForLabel(activeLabel) ?? "QRS" : undefined;
        const lbl = tool === "wave" && !waveKindForLabel(activeLabel) ? labelForWave(labels, wave!) ?? activeLabel : activeLabel;
        drag.current = { kind: "create", panel: p, draft: { kind: tool, lead: e.shiftKey ? "all" : p.lead, t0: t, t1: t, label: lbl, wave } };
        capture();
        return;
      }
      case "rhythm": {
        if (!host) return;
        drag.current = { kind: "create", panel: host, draft: { kind: "rhythm", t0: t, t1: t, rhythm: rhythmCode } };
        capture();
        return;
      }
      case "caliper": {
        if (!p) return;
        setCaliper({ t0: t, t1: t, y0: y, y1: y, panel: p, qt: e.altKey });
        drag.current = { kind: "caliper", panel: p };
        capture();
        return;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const { x, y } = pos(e);
    if (!d) {
      // Hover cursor feedback for the select tool.
      const c = e.currentTarget;
      if (tool === "select") {
        const hit = leadLabelAt(frame, x, y) ? null : hitTest(x, y);
        c.style.cursor = leadLabelAt(frame, x, y) ? "pointer" : hit ? (hit.handle === "move" ? "move" : "ew-resize") : "grab";
      }
      return;
    }
    if (d.kind === "pan") {
      scrollTo(d.offset0 - (x - d.x0) / frame.pxPerSec);
      return;
    }
    if (d.kind === "caliper") {
      const t = clamp(tOf(d.panel, frame.pxPerSec, x), 0, duration);
      setCaliper((c) => (c ? { ...c, t1: t, y1: y } : c));
      return;
    }
    if (d.kind === "create") {
      d.draft.t1 = clamp(tOf(d.panel, frame.pxPerSec, x), 0, duration);
      redraw();
      return;
    }
    if (d.kind === "edit") {
      d.preview = editGeometry(d, clamp(tOf(d.panel, frame.pxPerSec, x), 0, duration));
      redraw();
      return;
    }
    if (d.kind === "band") {
      d.x1 = x;
      d.y1 = y;
      redraw();
    }
  };

  /** Annotations inside a rubber band: each lead strip (and the rhythm track) it crosses, over the time it covers there. */
  const bandHits = (b: { x0: number; y0: number; x1: number; y1: number }) => {
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
    for (const a of mine) {
      const g = a.geometry;
      const span: [number, number] | null = g.type === "beat" ? [g.t, g.t] : g.type === "wave" ? [g.onset, g.offset] : g.type === "interval" || g.type === "rhythm" ? [g.start, g.end] : null;
      if (!span) continue;
      const lead = g.type === "rhythm" ? null : (g as { lead: string }).lead;
      const hit = ranges.some((r) => (lead === null ? r.lead === null : r.lead !== null && (lead === "all" || lead === r.lead)) && span[1] >= r.t0 && span[0] <= r.t1);
      if (hit) ids.push(a.id);
    }
    return ids;
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const s = useStudio.getState();
    if (d.kind === "create") {
      const a = q(Math.min(d.draft.t0, d.draft.t1));
      const b = q(Math.max(d.draft.t0, d.draft.t1));
      const dr = d.draft;
      let ann: Annotation | null = null;
      if (dr.kind === "interval" && b - a >= 0.01) {
        ann = newAnnotation({ itemId: item.id, label: dr.label, geometry: { type: "interval", lead: dr.lead, start: a, end: b } });
      } else if (dr.kind === "wave" && b - a >= 0.01) {
        const sig = signalFor(dr.lead);
        const peak = sig ? q(wavePeak(sig, fs, a, b)) : undefined;
        ann = newAnnotation({ itemId: item.id, label: dr.label, geometry: { type: "wave", lead: dr.lead, wave: dr.wave ?? "QRS", onset: a, peak, offset: b } });
      } else if (dr.kind === "rhythm" && b - a >= 0.05) {
        ann = newAnnotation({ itemId: item.id, label: dr.rhythm, geometry: { type: "rhythm", start: a, end: b, rhythm: dr.rhythm } });
      }
      if (ann) {
        s.add(ann);
        s.select(ann.id);
      } else redraw();
    } else if (d.kind === "edit") {
      if (JSON.stringify(d.preview) !== JSON.stringify(d.orig)) s.update(d.id, { geometry: d.preview });
      else redraw();
    } else if (d.kind === "band") {
      const ids = bandHits(d);
      // Shift-band adds to the existing selection.
      s.selectMany([...new Set([...s.selectedIds.filter((id) => mine.some((a) => a.id === id)), ...ids])]);
      redraw();
    }
  };

  // Wheel: scroll time; Ctrl/⌘ + wheel zooms (needs a non-passive listener to stop page zoom).
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    if (!rec) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const { x } = pos(e);
      const p = frame.cols === 1 ? frame.panels[0] : undefined;
      zoom(e.deltaY < 0 ? 1 : -1, p ? clamp(tOf(p, frame.pxPerSec, x), 0, duration) : undefined);
      return;
    }
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    scrollTo(frame.offset + (delta / 600) * span);
  };
  useEffect(() => {
    const c = main.canvasRef.current;
    if (!c) return;
    const h = (e: WheelEvent) => wheelRef.current(e);
    c.addEventListener("wheel", h, { passive: false });
    return () => c.removeEventListener("wheel", h);
  }, [main.canvasRef]);

  /** Zoom in (+1) / out (−1). Fit mode scales the window; paper mode steps the paper speed. */
  const zoom = (dir: 1 | -1, anchor?: number) => {
    const a = anchor ?? frame.offset + span / 2;
    const frac = (a - frame.offset) / span;
    let next: number;
    if (display.scale === "paper") {
      const i = SPEEDS.indexOf(display.speed);
      const speed = SPEEDS[clamp((i < 0 ? 1 : i) + dir, 0, SPEEDS.length - 1)];
      setDisplay({ speed });
      next = span * (display.speed / speed);
    } else {
      next = clamp(windowSec * (dir > 0 ? 0.8 : 1.25), 0.5, duration);
      setWindowSec(next);
    }
    setOffset(clamp(a - frac * next, 0, Math.max(0, duration - next)));
  };

  // Overview strip: click or drag to move the window.
  const onOverview = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.type === "pointerdown") {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { kind: "overview" };
    } else if (drag.current?.kind !== "overview") return;
    const r = e.currentTarget.getBoundingClientRect();
    centre(overviewTimeAt(r.width, duration, e.clientX - r.left));
  };

  // ---------------------------------------------------------------- review workflow
  const review = useMemo(
    () => mine.filter((a) => a.provenance === "ai-suggested" && timeOf(a.geometry) !== undefined).sort((a, b) => timeOf(a.geometry)! - timeOf(b.geometry)!),
    [mine],
  );
  const goReview = (dir: 1 | -1, after?: Annotation | null) => {
    if (!review.length) return false;
    const cur = after ?? selected;
    const idx = cur ? review.findIndex((a) => a.id === cur.id) : -1;
    let next: Annotation | undefined;
    if (idx >= 0) next = review[idx + dir];
    else {
      const t = cur ? timeOf(cur.geometry) ?? frame.offset : dir > 0 ? frame.offset - 1e-6 : frame.offset + span;
      next = dir > 0 ? review.find((a) => timeOf(a.geometry)! > t) : [...review].reverse().find((a) => timeOf(a.geometry)! < t);
    }
    next ??= dir > 0 ? review.find((a) => a.id !== cur?.id) : [...review].reverse().find((a) => a.id !== cur?.id);
    if (!next) {
      useStudio.getState().select(null);
      return true;
    }
    useStudio.getState().select(next.id);
    centre(timeOf(next.geometry)!);
    return true;
  };

  const runDetect = async () => {
    if (!rec || detecting) return;
    const lead = display.layout === "single" ? display.focus : rec.leads.II ? "II" : leadNames[0];
    setDetecting(true);
    try {
      const peaks = await detectBeats(rec.leads[lead], rec.fs);
      const s = useStudio.getState();
      const beats = s.annotations.filter((a) => a.itemId === item.id && a.geometry.type === "beat");
      const stale = beats.filter((a) => a.provenance === "ai-suggested" && a.attributes?.source === "pan-tompkins" && isEditable(a, s.lockedLabels));
      const kept = beats.filter((a) => !stale.includes(a));
      const label = labels.includes("QRS complex") ? "QRS complex" : labelForWave(labels, "QRS") ?? s.activeLabel ?? labels[0] ?? "beat";
      const fresh = peaks
        .map((p) => q(p / rec.fs))
        .filter((t) => !kept.some((k) => Math.abs((k.geometry as { t: number }).t - t) < 0.15))
        .map((t) => newAnnotation({ itemId: item.id, label, geometry: { type: "beat", lead: "all", t, code: "N" }, provenance: "ai-suggested", attributes: { source: "pan-tompkins", lead } }));
      // One undo step: drop the previous unreviewed detector beats and add the new ones.
      if (stale.length || fresh.length) s.batch({ remove: stale.map((a) => a.id), upsert: fresh });
      const hr = peaks.length > 1 ? (60 * (peaks.length - 1)) / ((peaks[peaks.length - 1] - peaks[0]) / rec.fs) : 0;
      setNotice(`${peaks.length} beats on lead ${lead}${hr ? ` · ~${Math.round(hr)} bpm` : ""} · ${fresh.length} suggested${kept.length ? `, ${peaks.length - fresh.length} already marked` : ""}. Tab to review.`);
    } finally {
      setDetecting(false);
    }
  };
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(id);
  }, [notice]);

  // ---------------------------------------------------------------- keyboard
  /** Set the WFDB code of every selected, editable beat in one undo step. */
  const setCodeOfSelected = (code: string) => {
    const s = useStudio.getState();
    const beats = s.annotations.filter((a) => a.itemId === item.id && s.selectedIds.includes(a.id) && a.geometry.type === "beat" && isEditable(a, s.lockedLabels));
    if (!beats.length) return false;
    s.batch({ update: beats.map((a) => ({ id: a.id, patch: { geometry: { ...(a.geometry as Extract<Geometry, { type: "beat" }>), code } } })) });
    return true;
  };

  // Keys come from the SHORTCUTS registry (lib/shortcuts.ts); handlers return false to pass a key on.
  const ctxNow = () => {
    const s = useStudio.getState();
    return {
      s,
      sel: s.annotations.find((a) => a.id === s.selectedId && a.itemId === item.id),
      chosen: s.annotations.filter((a) => a.itemId === item.id && s.selectedIds.includes(a.id) && isEditable(a, s.lockedLabels)),
    };
  };
  useCommands(
    {
      scrollWindow: (e) => {
        const step = e.shiftKey ? span : span * 0.1;
        scrollTo(frame.offset + (e.key === "ArrowRight" ? step : -step));
      },
      zoomTime: (e) => zoom(e.key === "-" ? -1 : 1),
      // `matches` lets a plain named-key combo ("Tab") also match with Shift, so read the direction here.
      nextSuggestion: (e) => goReview(e.shiftKey ? -1 : 1),
      prevSuggestion: () => goReview(-1),
      acceptSuggestion: () => {
        // Accept every selected AI suggestion as one undo step, then move on.
        const { s, chosen } = ctxNow();
        const ai = chosen.filter((a) => a.provenance === "ai-suggested");
        if (!ai.length) return false;
        const last = ai.reduce((m, a) => (timeOf(a.geometry)! > timeOf(m.geometry)! ? a : m));
        s.batch({ update: ai.map((a) => ({ id: a.id, patch: { provenance: "human-created" as const } })) });
        goReview(1, last);
      },
      rejectSuggestion: () => {
        // A single AI suggestion: reject and advance. Multi-selections go to the shell's bulk delete.
        const { s, sel } = ctxNow();
        if (s.selectedIds.length > 1 || sel?.provenance !== "ai-suggested" || !isEditable(sel, s.lockedLabels)) return false;
        goReview(1, sel);
        s.remove(sel.id);
      },
      setBeatCode: (e) => {
        // Letter by typed character, or physical key on non-Latin layouts (same rule as `matches`).
        const code = e.key === "/" ? "/" : /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : e.code.replace(/^Key/, "");
        if (setCodeOfSelected(code)) {
          setBeatCode(code);
          return;
        }
        if (code !== "/" && useStudio.getState().tool === "beat") {
          setBeatCode(code);
          return;
        }
        return false;
      },
      clearCaliper: () => {
        if (drag.current) {
          drag.current = null;
          redraw();
        } else if (leadMenu) setLeadMenu(null);
        else if (calibrating) setCalibrating(false);
        else if (caliper) setCaliper(null);
        else return false;
      },
    },
    { enabled: !!rec, scope: ["inkling.timeseries", "inkling.core"] },
  );

  // ---------------------------------------------------------------- render
  const cursor = { select: "grab", pan: "grab", interval: "col-resize", wave: "col-resize", rhythm: "col-resize", beat: "crosshair", caliper: "crosshair" }[tool as string] ?? "default";
  const filtersOn = !isPassthrough(filterCfg);

  return (
    <div className="flex h-full flex-col bg-canvas text-canvas-foreground">
      {/* Display bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-white/10 px-3 py-1.5 text-xs">
        <BarSegmented label="Layout" value={display.layout} options={LAYOUTS.map((l) => ({ v: l.v, label: l.label, title: l.title }))} onChange={(layout) => setDisplay(layout === "single" ? { layout } : { layout, prevLayout: layout })} />
        <BarSegmented
          label="Scale"
          value={display.scale}
          options={[
            { v: "fit", label: "Fit", title: "Rows fill the screen" },
            { v: "paper", label: "Paper", title: "True paper scale: mm/s and mm/mV at 96 CSS px per inch (browser zoom 100%)" },
          ]}
          onChange={(scale) => setDisplay({ scale })}
        />
        {display.scale === "fit" ? (
          <BarSegmented label="Window" value={windowSec} options={WINDOWS.map((w) => ({ v: w, label: `${w}s` }))} onChange={(w) => {
            setWindowSec(w);
            setOffset((o) => clamp(o, 0, Math.max(0, duration - w)));
          }} />
        ) : (
          <BarSegmented label="Speed" value={display.speed} options={SPEEDS.map((v) => ({ v, label: `${v}` }))} suffix="mm/s" onChange={(speed) => setDisplay({ speed })} />
        )}
        <BarSegmented label="Gain" value={display.gain} options={GAINS.map((v) => ({ v, label: `${v}` }))} suffix="mm/mV" onChange={(gain) => setDisplay({ gain })} />
        <button
          onClick={() => setCalibrating(true)}
          className={cn("rounded-md px-1.5 py-0.5 hover:bg-white/10", screen.calibrated ? "text-canvas-foreground/80" : "text-canvas-foreground/55")}
          title={`Calibrate screen for true paper scale (now ${screen.pxPerMm.toFixed(3)} px/mm${screen.calibrated ? ", calibrated" : ", CSS default"})`}
        >
          {screen.calibrated ? "✓ Calibrated" : "Calibrate screen"}
        </button>
        <span className="h-4 w-px bg-white/10" />
        <BarPick label="HP" value={display.hp} options={HP} unit="Hz" onChange={(hp) => setDisplay({ hp })} title="High-pass (baseline wander)" />
        <BarPick label="Notch" value={display.notch} options={NOTCH} unit="Hz" onChange={(notch) => setDisplay({ notch })} title="Mains notch" />
        <BarPick label="LP" value={display.lp} options={LP} unit="Hz" onChange={(lp) => setDisplay({ lp })} title="Low-pass (muscle noise)" />
        <span
          className={cn("tnum flex items-center gap-1 rounded px-1.5 py-0.5", filtersOn ? "bg-chart-4/20 text-chart-4" : "bg-white/5 text-canvas-foreground/50")}
          title="Display filters are zero-phase and never change the stored time axis or annotations"
        >
          {filterPending && <Loader2 className="h-3 w-3 animate-spin" />}
          {filtersOn ? `Filtered ${filterText(filterCfg)}` : "Unfiltered"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={runDetect}
            disabled={!rec || detecting}
            className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-0.5 hover:bg-white/15 disabled:opacity-50"
            title={`Pan–Tompkins R-peak detection on lead ${display.layout === "single" ? display.focus : "II"}; results are AI suggestions to review`}
          >
            {detecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <HeartPulse className="h-3 w-3" />} Detect beats
          </button>
          <button
            onClick={() => setDisplay({ panel: !display.panel })}
            aria-pressed={display.panel}
            className={cn("rounded-md p-1 hover:bg-white/10", display.panel && "text-primary")}
            title="Measurements & record statements"
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {/* Tool bar: options of the active tool */}
      <ToolOptions
        tool={tool}
        beatCode={beatCode}
        setBeatCode={(code) => {
          setBeatCode(code);
          setCodeOfSelected(code);
        }}
        rhythmCode={rhythmCode}
        setRhythmCode={(r) => {
          setRhythmCode(r);
          const s = useStudio.getState();
          const sel = s.annotations.find((a) => a.id === s.selectedId);
          if (sel?.geometry.type === "rhythm" && sel.itemId === item.id && isEditable(sel, s.lockedLabels)) s.update(sel.id, { label: r, geometry: { ...sel.geometry, rhythm: r } });
        }}
        activeLabel={activeLabel}
        snap={display.snap}
        setSnap={(snap) => setDisplay({ snap })}
        marchOut={display.marchOut}
        setMarchOut={(marchOut) => setDisplay({ marchOut })}
        dx={rec?.dx}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={main.containerRef} className="relative min-h-0 flex-1">
            <canvas
              ref={main.canvasRef}
              style={{ width: size.width, height: size.height, cursor, touchAction: "none" }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              data-testid="signal-canvas"
            />
            {/* Transient notices sit over the canvas so they never reflow the toolbars mid-gesture. */}
            {(notice || review.length > 0) && (
              <div className="pointer-events-none absolute right-2 bottom-7 flex max-w-[70%] items-center gap-2 text-xs" role="status" aria-live="polite">
                {notice && <span className="truncate rounded bg-black/70 px-2 py-0.5 text-canvas-foreground/85">{notice}</span>}
                {review.length > 0 && (
                  <span className="shrink-0 rounded bg-black/70 px-1.5 py-0.5 text-prov-ai" title="Tab / Shift+Tab: next / previous · Enter: accept · Delete: reject · Shift+letter: set beat code">
                    {review.length} to review · Tab
                  </span>
                )}
              </div>
            )}
            <div role="status" aria-live="polite" className="sr-only" data-testid="caliper-readout">
              {caliperFull?.readout.join(" · ") ?? ""}
            </div>
            {calibrating && (
              <CalibrateDialog
                pxPerMm={screen.pxPerMm}
                calibrated={screen.calibrated}
                onSave={(k) => {
                  screen.setCssPxPerMm(k);
                  setCalibrating(false);
                }}
                onClose={() => setCalibrating(false)}
              />
            )}
            {leadMenu && (
              <LeadMenu
                lead={leadMenu.lead}
                x={leadMenu.x}
                y={leadMenu.y}
                focused={display.layout === "single" && display.focus === leadMenu.lead}
                gain={display.leadGain[leadMenu.lead]}
                onFocus={() => {
                  if (display.layout === "single" && display.focus === leadMenu.lead) setDisplay({ layout: display.prevLayout });
                  else setDisplay({ layout: "single", focus: leadMenu.lead, prevLayout: display.layout === "single" ? display.prevLayout : display.layout });
                  setLeadMenu(null);
                }}
                onGain={(g) => {
                  const leadGain = { ...display.leadGain };
                  if (g === undefined) delete leadGain[leadMenu.lead];
                  else leadGain[leadMenu.lead] = g;
                  setDisplay({ leadGain });
                  setLeadMenu(null);
                }}
                onClose={() => setLeadMenu(null)}
              />
            )}
            {!rec && !error && <CanvasNotice>Loading recording…</CanvasNotice>}
            {error && <CanvasNotice>{error}</CanvasNotice>}
          </div>
          <div ref={ov.containerRef} className="relative h-10 shrink-0 border-t border-white/10">
            <canvas
              ref={ov.canvasRef}
              style={{ width: ov.size.width, height: ov.size.height, cursor: "pointer", touchAction: "none" }}
              onPointerDown={onOverview}
              onPointerMove={onOverview}
              onPointerUp={() => (drag.current = null)}
              aria-label="Record overview: click or drag to move the window"
            />
          </div>
        </div>
        {display.panel && rec && <SidePanel itemId={item.id} anns={mine} all={mineAll} m={m} dx={rec.dx} onJump={(a) => {
          useStudio.getState().select(a.id);
          const t = timeOf(a.geometry);
          if (t !== undefined) centre(t);
        }} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ small controls

function ToolOptions(p: {
  tool: string;
  beatCode: string;
  setBeatCode: (c: string) => void;
  rhythmCode: string;
  setRhythmCode: (r: string) => void;
  activeLabel: string | null;
  snap: boolean;
  setSnap: (v: boolean) => void;
  marchOut: boolean;
  setMarchOut: (v: boolean) => void;
  dx?: string;
}) {
  const wave = waveKindForLabel(p.activeLabel);
  return (
    <div className="flex h-8 shrink-0 items-center gap-x-3 overflow-x-auto border-b border-white/10 px-3 text-xs whitespace-nowrap">
      {p.tool === "beat" && (
        <div className="flex items-center gap-0.5" role="group" aria-label="Beat code">
          <span className="mr-1 text-canvas-foreground/55">Code</span>
          {BEAT_CODES.map((c) => (
            <button
              key={c}
              title={`${beatCodeName(c)}${SHIFT_BEAT_CODES.has(c) ? ` (Shift+${c})` : c === "/" ? " (/)" : ""}`}
              aria-pressed={c === p.beatCode}
              onClick={() => p.setBeatCode(c)}
              className={cn("min-w-5 rounded px-1 py-0.5 font-mono font-semibold", c === p.beatCode ? "bg-primary text-primary-foreground" : "text-canvas-foreground/75 hover:bg-white/10")}
            >
              {c}
            </button>
          ))}
          <span className="ml-2 text-canvas-foreground/45">Click places on the lead · Shift-click: all leads</span>
        </div>
      )}
      {p.tool === "rhythm" && (
        <label className="flex items-center gap-1">
          <span className="text-canvas-foreground/55">Rhythm</span>
          <select value={p.rhythmCode} onChange={(e) => p.setRhythmCode(e.target.value)} className="h-6 rounded-md border border-white/15 bg-canvas px-1 text-xs">
            {RHYTHMS.map((r) => (
              <option key={r.aux} value={r.aux}>
                {r.aux} — {r.name}
              </option>
            ))}
          </select>
          <span className="ml-1 text-canvas-foreground/45">Drag on the rhythm track (or any lead)</span>
        </label>
      )}
      {p.tool === "wave" && (
        <span className="text-canvas-foreground/60">
          Wave <b className="text-canvas-foreground">{wave ?? "QRS"}</b> {wave ? `from label “${p.activeLabel}”` : "(pick P wave / QRS complex / T wave label to change)"} · drag onset → offset · Shift: all leads
        </span>
      )}
      {p.tool === "interval" && <span className="text-canvas-foreground/60">Drag across a lead · Shift-drag: all leads</span>}
      {p.tool === "caliper" && (
        <>
          <span className="text-canvas-foreground/60">Drag to measure · Alt-drag Q onset → T end for QT/QTc · Esc clears</span>
          <BarToggle on={p.marchOut} onChange={p.setMarchOut} label="March-out" />
        </>
      )}
      {(p.tool === "beat" || p.tool === "select") && <BarToggle on={p.snap} onChange={p.setSnap} label="Snap to peak" />}
      {p.dx && <span className="ml-auto truncate text-canvas-foreground/45">Source Dx {p.dx}</span>}
    </div>
  );
}

function LeadMenu(p: { lead: string; x: number; y: number; focused: boolean; gain?: number; onFocus: () => void; onGain: (g: number | undefined) => void; onClose: () => void }) {
  return (
    <div
      className="absolute z-20 w-44 rounded-md border border-white/15 bg-canvas p-1 text-xs shadow-lg"
      style={{ left: Math.max(4, p.x), top: p.y + 8 }}
      onPointerDown={(e) => e.stopPropagation()}
      role="menu"
      aria-label={`Lead ${p.lead}`}
    >
      <div className="px-2 py-1 font-semibold">Lead {p.lead}</div>
      <button role="menuitem" onClick={p.onFocus} className="w-full rounded px-2 py-1 text-left hover:bg-white/10">
        {p.focused ? "Show all leads" : "Focus this lead"}
      </button>
      <div className="px-2 pt-1.5 pb-0.5 text-canvas-foreground/55">Gain (this lead)</div>
      <div className="flex gap-0.5 px-1 pb-1">
        {[undefined, 5, 10, 20].map((g) => (
          <button
            key={String(g)}
            role="menuitemradio"
            aria-checked={p.gain === g}
            onClick={() => p.onGain(g)}
            className={cn("tnum flex-1 rounded px-1 py-0.5", p.gain === g ? "bg-primary text-primary-foreground" : "hover:bg-white/10")}
          >
            {g ?? "Auto"}
          </button>
        ))}
      </div>
      <button onClick={p.onClose} className="sr-only">
        Close
      </button>
    </div>
  );
}
