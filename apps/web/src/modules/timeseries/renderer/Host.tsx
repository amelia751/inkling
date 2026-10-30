import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { CanvasNotice } from "@/kits/viewport-chrome/CanvasNotice";
import { useCanvasSize } from "@/kits/viewport-chrome/useCanvasSize";
import { useCommands } from "@/platform/commands";
import { labelNames } from "@/platform/environment";
import { matches } from "@/platform/keys";
import type { RendererProps } from "@/platform/module";
import { isEditable, useStudio, useToolOption, visibleFor } from "@/stores/studio";
import type { Annotation } from "@/types";
import { useScreenScale } from "../calibration";
import { parseStripConfig, TIMESERIES, type StripChartConfig } from "../config";
import { detectSuggestions } from "../detect";
import type { FilterConfig } from "../dsp";
import { filteredLeads } from "../dspClient";
import { bazett, beatTimes, fridericia, measure, rrAround } from "../measure";
import { kindOf, timeOf } from "../model";
import { infoOf, loadRecording, type Recording } from "../readers";
import { CalibrateDialog } from "./CalibrateDialog";
import { ChannelMenu, CONFIG_LAYOUT, DisplayBar, filterText, SPEEDS, ToolOptions, type Display } from "./controls";
import { overviewTimeAt, type Caliper } from "./draw";
import { computeFrame } from "./layout";
import { nextSuggestion, setCodeOfSelected, StripChartEngine } from "./StripChartEngine";
import { ns } from "@studio/plugin-contracts/naming";

/**
 * `inkling.timeseries.renderers.strip-chart`: the React host. Loads the recording through
 * its reader, runs display filters in the DSP worker, keeps the expert's display settings
 * (per `displayKey`), binds the module's commands and hands pointer work and drawing to the
 * engine.
 */

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function defaultDisplay(cfg: StripChartConfig): Display {
  const layout = CONFIG_LAYOUT[cfg.layout];
  return {
    layout,
    prevLayout: layout === "single" ? "12x1" : layout,
    focus: cfg.primaryChannel ?? "",
    scale: "fit",
    speed: cfg.paperSpeed,
    gain: cfg.gain,
    leadGain: {},
    ...cfg.filters,
    snap: true,
    marchOut: false,
  };
}

function useDisplay(cfg: StripChartConfig) {
  const key = cfg.displayKey;
  const [d, setD] = useState<Display>(() => {
    const base = defaultDisplay(cfg);
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...base, ...(JSON.parse(raw) as Partial<Display>) } : base;
    } catch {
      return base;
    }
  });
  const set = useCallback(
    (patch: Partial<Display>) => {
      setD((prev) => {
        const next = { ...prev, ...patch };
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // storage unavailable: settings last for the session only
        }
        return next;
      });
    },
    [key],
  );
  return [d, set] as const;
}

/** Median of a signal (baseline offset used to centre raw traces in their rows). */
function median(x: Float32Array): number {
  if (!x.length) return 0;
  const step = Math.max(1, Math.floor(x.length / 2000));
  const s: number[] = [];
  for (let i = 0; i < x.length; i += step) if (!Number.isNaN(x[i])) s.push(x[i]);
  s.sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}

const CURSOR: Record<string, string> = { select: "grab", pan: "grab", interval: "col-resize", wave: "col-resize", rhythm: "col-resize", beat: "crosshair", caliper: "crosshair" };

export function StripChartHost({ env, item, config, runtime }: RendererProps) {
  const cfg = useMemo(() => parseStripConfig(config), [config]);
  const labels = useMemo(() => labelNames(env.labels), [env.labels]);
  const main = useCanvasSize();
  const ov = useCanvasSize();
  const size = main.size;
  const [rec, setRec] = useState<Recording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [display, setDisplay] = useDisplay(cfg);
  const [windowSec, setWindowSec] = useState(10);
  const [offset, setOffset] = useState(0);
  const [filtered, setFiltered] = useState<{ key: string; leads: Record<string, Float32Array> } | null>(null);
  const [caliper, setCaliper] = useState<Omit<Caliper, "readout"> | null>(null);
  const [menu, setMenu] = useState<{ lead: string; x: number; y: number } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const tool = useStudio((s) => s.tool);
  const activeLabel = useStudio((s) => s.activeLabel);
  const annotations = useStudio((s) => s.annotations);
  const selectedId = useStudio((s) => s.selectedId);
  const selectedIds = useStudio((s) => s.selectedIds);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const hiddenLabels = useStudio((s) => s.hiddenLabels);
  const overlayOpacity = useStudio((s) => s.overlayOpacity);
  const setViewerStatus = useStudio((s) => s.setViewerStatus);
  const screen = useScreenScale();
  // The code new instants / track spans get: the beat and rhythm tools' `code` option, else the vocabulary's first.
  const pick = (codes: StripChartConfig["instantCodes"], v: string) => (codes.some((c) => c.id === v) || !codes.length ? v : codes[0].id);
  const instantCode = pick(cfg.instantCodes, useToolOption("beat", "code", ""));
  const trackCode = pick(cfg.trackCodes, useToolOption("rhythm", "code", ""));
  const setInstantCode = (c: string) => useStudio.getState().setToolOption("beat", "code", c);
  const setTrackCode = (c: string) => useStudio.getState().setToolOption("rhythm", "code", c);

  // ---------------------------------------------------------------- data
  useEffect(() => {
    const ctl = new AbortController();
    setRec(null);
    setError(null);
    setOffset(0);
    setCaliper(null);
    loadRecording(item, { reader: cfg.reader, sampleRate: cfg.sampleRate, signal: ctl.signal })
      .then((r) => {
        // Keep a header an exporter already fetched; the samples are authoritative for the rest.
        runtime.publish("signalInfo", { ...runtime.get<object>("signalInfo"), ...infoOf(r) });
        setRec(r);
      })
      .catch((e) => !ctl.signal.aborted && setError(e instanceof Error && e.message === "404" ? "Recording not found." : "This recording could not be loaded."));
    return () => ctl.abort();
  }, [item, cfg.reader, cfg.sampleRate, runtime]);

  const filterCfg = useMemo<FilterConfig>(() => ({ hp: display.hp, notch: display.notch, lp: display.lp }), [display.hp, display.notch, display.lp]);
  const wantKey = rec ? `${rec.record}|${filterText(filterCfg)}` : "";
  useEffect(() => {
    if (!rec) return;
    let live = true;
    const key = `${rec.record}|${filterText(filterCfg)}`;
    filteredLeads(rec.record, rec.fs, rec.data, filterCfg).then((leads) => live && setFiltered({ key, leads }));
    return () => {
      live = false;
    };
  }, [rec, filterCfg]);
  const filterPending = !!rec && filtered?.key !== wantKey;
  // Keep showing the previous filter output of the same record while the new one computes.
  const leads = rec && filtered?.key.startsWith(`${rec.record}|`) ? filtered.leads : (rec?.data ?? {});
  const baseline = useMemo(() => Object.fromEntries(Object.entries(leads).map(([k, v]) => [k, median(v)])), [leads]);

  const fs = rec?.fs ?? 500;
  const duration = rec ? rec.samples / rec.fs : 10;
  const channels = useMemo(() => rec?.channels ?? [], [rec]);
  const primary = cfg.primaryChannel && channels.includes(cfg.primaryChannel) ? cfg.primaryChannel : (channels[0] ?? "");
  // A plain grid has no paper scale.
  const paper = cfg.grid === "ecg" && display.scale === "paper";
  const gainUnit = cfg.unit ? `mm/${cfg.unit}` : "mm/unit";

  const frame = useMemo(
    () =>
      computeFrame({
        width: size.width,
        height: size.height,
        leads: channels.length ? channels : [primary || "—"],
        mode: display.layout,
        focus: display.focus,
        scale: paper ? "paper" : "fit",
        speed: display.speed,
        gain: display.gain,
        windowSec,
        offset,
        duration,
        pxPerMm: screen.pxPerMm,
        order: cfg.channelOrder,
        stripChannel: primary,
      }),
    [size.width, size.height, channels, primary, display.layout, display.focus, paper, display.speed, display.gain, windowSec, offset, duration, screen.pxPerMm, cfg.channelOrder],
  );
  const span = frame.span;
  const pxPerMvFor = useCallback((lead: string) => frame.pxPerMv * ((display.leadGain[lead] ?? display.gain) / display.gain), [frame.pxPerMv, display.leadGain, display.gain]);

  const mineAll = useMemo(() => annotations.filter((a) => a.itemId === item.id), [annotations, item.id]);
  const mine = useMemo(() => visibleFor(annotations, item.id, hiddenLabels), [annotations, item.id, hiddenLabels]);
  const m = useMemo(() => measure(mine), [mine]);
  const times = useMemo(() => beatTimes(mine), [mine]);
  const selected = mineAll.find((a) => a.id === selectedId) ?? null;

  const scrollTo = useCallback((t0: number) => setOffset(clamp(t0, 0, Math.max(0, duration - span))), [duration, span]);
  const centre = useCallback((t: number) => scrollTo(t - span / 2), [scrollTo, span]);

  // Bring a selection made elsewhere (measurements panel, review list) into view.
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
    const scale = paper ? `${display.speed} mm/s · ${display.gain} ${gainUnit}` : `fit · ${display.gain} ${gainUnit}`;
    const hr = cfg.ecg && m.hr ? ` · HR ${Math.round(m.hr)} bpm` : "";
    setViewerStatus(`${rec.fs} Hz · ${channels.length} ${cfg.channelNoun}s · ${frame.offset.toFixed(2)}–${(frame.offset + span).toFixed(2)} s of ${duration.toFixed(0)} s · ${scale} · ${filterText(filterCfg)}${hr}`);
  }, [rec, channels.length, frame.offset, span, duration, paper, display.speed, display.gain, gainUnit, filterCfg, m.hr, cfg.ecg, cfg.channelNoun, setViewerStatus]);

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
      const dv = (caliper.y0 - caliper.y1) / pxPerMvFor(caliper.panel.lead);
      lines.push(`Δt ${Math.round(dt * 1000)} ms`);
      if (dt > 0.05) lines.push(cfg.ecg ? `${(60 / dt).toFixed(0)} bpm` : `${(1 / dt).toFixed(2)} Hz`);
      lines.push(`ΔV ${dv >= 0 ? "+" : ""}${dv.toFixed(2)}${cfg.unit ? ` ${cfg.unit}` : ""}`);
    }
    return { ...caliper, readout: lines };
  }, [caliper, times, pxPerMvFor, cfg.ecg, cfg.unit]);

  // ---------------------------------------------------------------- engine
  const scrollRef = useRef(scrollTo);
  scrollRef.current = scrollTo;
  const centreRef = useRef(centre);
  centreRef.current = centre;
  const engineRef = useRef<StripChartEngine | null>(null);
  engineRef.current ??= new StripChartEngine({ redraw, scrollTo: (t) => scrollRef.current(t), centre: (t) => centreRef.current(t), setCaliper, openChannelMenu: setMenu });
  const engine = engineRef.current;
  engine.update({
    itemId: item.id,
    cfg,
    frame,
    width: size.width,
    height: size.height,
    fs,
    duration,
    leads,
    channels,
    baseline,
    pxPerMvFor,
    anns: mine,
    selectedId,
    selectedIds: selectedSet,
    labels,
    activeLabel,
    tool,
    snap: display.snap,
    paper,
    opacity: overlayOpacity,
    note: `${paper ? `${display.speed} mm/s · ` : ""}${display.gain} ${gainUnit} · ${filterText(filterCfg)}`,
    marchOut: display.marchOut,
    focusLead: display.layout === "single" ? display.focus : undefined,
    caliper: caliperFull,
    instantCode,
    trackCode,
    primary,
  });

  useEffect(() => {
    if (rec) engine.draw(main.canvasRef.current?.getContext("2d"), ov.canvasRef.current?.getContext("2d"), ov.size);
  });

  const pos = (e: { clientX: number; clientY: number }) => {
    const r = main.canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Zoom in (+1) / out (−1). Fit mode scales the window; paper mode steps the paper speed. */
  const zoom = (dir: 1 | -1, anchor?: number) => {
    const a = anchor ?? frame.offset + span / 2;
    const frac = (a - frame.offset) / span;
    let next: number;
    if (paper) {
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

  // Wheel: scroll time; Ctrl/⌘ + wheel zooms (needs a non-passive listener to stop page zoom).
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelRef.current = (e: WheelEvent) => {
    if (!rec) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const { x } = pos(e);
      const p = frame.cols === 1 ? frame.panels[0] : undefined;
      zoom(e.deltaY < 0 ? 1 : -1, p ? clamp(p.t0 + (x - p.x) / frame.pxPerSec, 0, duration) : undefined);
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

  // ---------------------------------------------------------------- review workflow
  const review = useMemo(
    () => mine.filter((a) => a.provenance === "ai-suggested" && timeOf(a.geometry) !== undefined).sort((a, b) => timeOf(a.geometry)! - timeOf(b.geometry)!),
    [mine],
  );
  const goReview = (dir: 1 | -1, after?: Annotation | null) => {
    if (!review.length) return false;
    const next = nextSuggestion(review, after ?? selected, dir, [frame.offset, frame.offset + span]);
    if (!next) {
      useStudio.getState().select(null);
      return true;
    }
    useStudio.getState().select(next.id);
    centre(timeOf(next.geometry)!);
    return true;
  };

  const runDetect = async () => {
    if (!rec || detecting || !cfg.ecg) return;
    const lead = display.layout === "single" && rec.data[display.focus] ? display.focus : primary;
    setDetecting(true);
    try {
      setNotice(await detectSuggestions({ itemId: item.id, rec, lead, label: engine.instantLabel(), code: cfg.instantCodes[0]?.id ?? "", q: engine.q }));
    } finally {
      setDetecting(false);
    }
  };
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(id);
  }, [notice]);

  // ---------------------------------------------------------------- commands
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
        // The vocabulary code whose hotkey this is. It sets the selected instants' code; a
        // Shift hotkey with nothing selected arms the beat tool's code instead.
        const code = cfg.instantCodes.find((c) => c.hotkey && matches(e, c.hotkey));
        if (!code) return false;
        if (setCodeOfSelected(item.id, code.id)) {
          setInstantCode(code.id);
          return;
        }
        if (/^shift\+/i.test(code.hotkey!) && useStudio.getState().tool === "beat") {
          setInstantCode(code.id);
          return;
        }
        return false;
      },
      clearCaliper: () => {
        if (engine.cancel()) return;
        if (menu) setMenu(null);
        else if (calibrating) setCalibrating(false);
        else if (caliper) setCaliper(null);
        else return false;
      },
      detectBeats: () => {
        if (!rec || detecting || !cfg.ecg) return false;
        void runDetect();
      },
      calibrateScreen: () => {
        if (cfg.grid !== "ecg") return false;
        setCalibrating(true);
      },
    },
    { enabled: !!rec, scope: [TIMESERIES, ns("core")] },
  );

  // ---------------------------------------------------------------- render
  const wave = tool === "wave" && activeLabel ? engine.waveFor(activeLabel) : undefined;
  const overviewAt = (el: HTMLElement) => (x: number) => overviewTimeAt(el.getBoundingClientRect().width, duration, x);
  return (
    <div className="flex h-full flex-col bg-canvas text-canvas-foreground">
      <DisplayBar
        cfg={cfg}
        channels={channels.length}
        display={display}
        paper={paper}
        setDisplay={setDisplay}
        windowSec={windowSec}
        setWindow={(w) => {
          setWindowSec(w);
          setOffset((o) => clamp(o, 0, Math.max(0, duration - w)));
        }}
        calibrated={screen.calibrated}
        pxPerMm={screen.pxPerMm}
        onCalibrate={() => setCalibrating(true)}
        filterPending={filterPending}
        detecting={detecting}
        canDetect={cfg.ecg && !!rec}
        onDetect={() => void runDetect()}
      />
      <ToolOptions
        cfg={cfg}
        tool={tool}
        instantCode={instantCode}
        setInstantCode={(code) => {
          setInstantCode(code);
          setCodeOfSelected(item.id, code);
        }}
        trackCode={trackCode}
        setTrackCode={(r) => {
          setTrackCode(r);
          const s = useStudio.getState();
          const sel = s.annotations.find((a) => a.id === s.selectedId);
          if (sel && sel.itemId === item.id && kindOf(sel) === "rhythm" && isEditable(sel, s.lockedLabels)) s.update(sel.id, { label: r, attributes: { ...sel.attributes, rhythm: r } });
        }}
        wave={wave?.wave}
        waveFromLabel={!!activeLabel && cfg.waves.some((w) => w.label === activeLabel)}
        activeLabel={activeLabel}
        snap={display.snap}
        setSnap={(snap) => setDisplay({ snap })}
        marchOut={display.marchOut}
        setMarchOut={(marchOut) => setDisplay({ marchOut })}
        dx={rec?.dx}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={main.containerRef} className="relative min-h-0 flex-1">
          <canvas
            ref={main.canvasRef}
            style={{ width: size.width, height: size.height, cursor: CURSOR[tool] ?? "default", touchAction: "none" }}
            onPointerDown={(e) => rec && engine.pointerDown(e.nativeEvent, e.currentTarget, pos(e))}
            onPointerMove={(e) => engine.pointerMove(e.nativeEvent, e.currentTarget, pos(e))}
            onPointerUp={() => engine.pointerUp()}
            onPointerCancel={() => engine.pointerUp()}
            data-testid="signal-canvas"
          />
          {/* Transient notices sit over the canvas so they never reflow the toolbars mid-gesture. */}
          {(notice || review.length > 0) && (
            <div className="pointer-events-none absolute right-2 bottom-7 flex max-w-[70%] items-center gap-2 text-xs" role="status" aria-live="polite">
              {notice && <span className="truncate rounded bg-black/70 px-2 py-0.5 text-canvas-foreground/85">{notice}</span>}
              {review.length > 0 && (
                <span className="shrink-0 rounded bg-black/70 px-1.5 py-0.5 text-prov-ai" title="Tab / Shift+Tab: next / previous · Enter: accept · Delete: reject · code hotkeys: set the code">
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
          {menu && (
            <ChannelMenu
              noun={cfg.channelNoun}
              lead={menu.lead}
              x={menu.x}
              y={menu.y}
              focused={display.layout === "single" && display.focus === menu.lead}
              gain={display.leadGain[menu.lead]}
              onFocus={() => {
                if (display.layout === "single" && display.focus === menu.lead) setDisplay({ layout: display.prevLayout });
                else setDisplay({ layout: "single", focus: menu.lead, prevLayout: display.layout === "single" ? display.prevLayout : display.layout });
                setMenu(null);
              }}
              onGain={(g) => {
                const leadGain = { ...display.leadGain };
                if (g === undefined) delete leadGain[menu.lead];
                else leadGain[menu.lead] = g;
                setDisplay({ leadGain });
                setMenu(null);
              }}
              onClose={() => setMenu(null)}
            />
          )}
          {!rec && !error && <CanvasNotice loading>Loading recording…</CanvasNotice>}
          {error && <CanvasNotice>{error}</CanvasNotice>}
        </div>
        <div ref={ov.containerRef} className="relative h-10 shrink-0 border-t border-white/10">
          <canvas
            ref={ov.canvasRef}
            style={{ width: ov.size.width, height: ov.size.height, cursor: "pointer", touchAction: "none" }}
            onPointerDown={(e) => engine.overview(e.nativeEvent, e.currentTarget, overviewAt(e.currentTarget))}
            onPointerMove={(e) => engine.overview(e.nativeEvent, e.currentTarget, overviewAt(e.currentTarget))}
            onPointerUp={() => engine.endOverview()}
            aria-label="Record overview: click or drag to move the window"
          />
        </div>
      </div>
    </div>
  );
}
