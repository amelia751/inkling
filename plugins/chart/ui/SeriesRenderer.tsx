import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import { newAnnotation, resolveLabelColor, resolveToken, useCommands, useHost, visibleFor } from "@studio/plugin-ui-sdk";
import { CHART, SeriesConfigSchema } from "./config";
import { nearest, prepare } from "./data";
import { useTable } from "./useTable";

const PALETTE = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];
const ts = (t: number) => t as UTCTimestamp;

/** Lines or candles over the item's rows; window (span) and event (instant) tools on the time axis. */
export function SeriesRenderer({ item, config, runtime, env }: RendererProps) {
  const cfg = useMemo(() => SeriesConfigSchema.parse(config), [config]);
  const { table, error } = useTable(item);
  const data = useMemo(() => (table ? prepare(table, cfg) : undefined), [table, cfg]);
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [frame, setFrame] = useState(0); // bumps when the visible range changes, to re-place windows
  const [draftStart, setDraftStart] = useState<number | null>(null);
  const annotations = useHost((s) => s.annotations);
  const tool = useHost((s) => s.tool);
  const labelIds = useMemo(() => env.labels.flatMap((g) => g.classes.map((c) => c.id)), [env.labels]);
  const hidden = useHost((s) => s.hiddenLabels);
  const mine = useMemo(() => visibleFor(annotations, item.id, hidden), [annotations, item.id, hidden]);

  useEffect(() => {
    const el = host.current;
    if (!el || !data) return;
    const fg = resolveToken("--foreground");
    const grid = resolveToken("--border", 0.6);
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: fg, attributionLogo: true },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      timeScale: { timeVisible: true, secondsVisible: true },
    });
    let main: ISeriesApi<SeriesType>;
    if (data.mode === "candles") {
      const s = chart.addSeries(CandlestickSeries, {});
      s.setData(data.bars.map((b) => ({ ...b, time: ts(b.time) })));
      main = s;
    } else {
      const all = data.lines.map((l, i) => {
        const s = chart.addSeries(LineSeries, { color: resolveToken(PALETTE[i % PALETTE.length]), lineWidth: 2, title: l.name });
        s.setData(l.points.map((p) => ({ time: ts(p.time), value: p.value })));
        return s;
      });
      main = all[0] ?? chart.addSeries(LineSeries, {});
    }
    if (data.volume.length) {
      const v = chart.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, color: resolveToken("--muted-foreground", 0.5) });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      v.setData(data.volume.map((p) => ({ time: ts(p.time), value: p.value })));
    }
    chart.timeScale().fitContent();
    const bump = () => setFrame((f) => f + 1);
    chart.timeScale().subscribeVisibleLogicalRangeChange(bump);
    chartRef.current = chart;
    mainRef.current = main;
    markersRef.current = createSeriesMarkers(main, []);
    runtime.publish("chartInfo", { mode: data.mode, rows: data.times.length, lines: data.lines.map((l) => l.name), bars: data.bars.length, start: data.times[0], end: data.times.at(-1) });
    bump();
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(bump);
      chart.remove();
      chartRef.current = mainRef.current = markersRef.current = null;
    };
  }, [data, runtime]);

  // Events as series markers.
  useEffect(() => {
    markersRef.current?.setMarkers(
      mine
        .filter((a) => a.geometry.type === "instant" && a.geometry.t != null)
        .map((a) => ({ time: ts((a.geometry as { t: number }).t), position: "aboveBar" as const, shape: "arrowDown" as const, color: resolveLabelColor(labelIds, a.label), text: a.label }))
        .sort((a, b) => a.time - b.time),
    );
  }, [mine, labelIds, data]);

  // Clicks (our own handler: the chart's click event drops quick second clicks as double-clicks),
  // snapped to the nearest row time.
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const chart = chartRef.current;
    if (!chart || !data || (tool !== "event" && tool !== "window")) return;
    const raw = chart.timeScale().coordinateToTime(e.clientX - e.currentTarget.getBoundingClientRect().left);
    const t = raw == null ? null : nearest(data.times, Number(raw));
    const s = useHost.getState();
    if (t == null || !s.activeLabel) return;
    if (tool === "event") s.add(newAnnotation({ itemId: item.id, label: s.activeLabel, geometry: { type: "instant", t }, attributes: { kind: "event" } }));
    else if (draftStart == null) setDraftStart(t);
    else {
      const [start, end] = [Math.min(draftStart, t), Math.max(draftStart, t)];
      setDraftStart(null);
      if (end > start) s.add(newAnnotation({ itemId: item.id, label: s.activeLabel, geometry: { type: "span", start, end }, attributes: { kind: "window" } }));
    }
  };

  useEffect(() => setDraftStart(null), [tool, item.id]);

  useCommands(
    {
      fitAll: () => chartRef.current?.timeScale().fitContent(),
      cancelWindow: () => {
        if (draftStart == null) return false;
        setDraftStart(null);
      },
    },
    { scope: CHART },
  );

  // Windows as translucent bands over the plot.
  const x = (t: number) => chartRef.current?.timeScale().timeToCoordinate(ts(t)) ?? null;
  void frame;
  const bands = mine.flatMap((a) => {
    if (a.geometry.type !== "span") return [];
    const [x0, x1] = [x(a.geometry.start), x(a.geometry.end)];
    if (x0 == null || x1 == null) return [];
    return [{ id: a.id, left: x0, width: Math.max(1, x1 - x0), color: resolveLabelColor(labelIds, a.label, 0.18), label: a.label }];
  });
  const draftX = draftStart != null ? x(draftStart) : null;

  return (
    <div className="flex h-full w-full flex-col bg-background" data-testid="chart-series" data-mode={data?.mode ?? ""} data-rows={data?.times.length ?? 0}>
      <div className="relative min-h-0 flex-1" onClick={onClick}>
        <div ref={host} className="absolute inset-0" />
        <div className="pointer-events-none absolute inset-0">
          {bands.map((b) => (
            <div key={b.id} data-testid="chart-window" className="absolute top-0 bottom-0" style={{ left: b.left, width: b.width, background: b.color }} title={b.label} />
          ))}
          {draftX != null && <div data-testid="chart-window-draft" className="absolute top-0 bottom-0 w-px bg-primary" style={{ left: draftX }} />}
        </div>
        {error && <div className="absolute inset-0 grid place-items-center text-sm text-destructive">Could not read the table: {error}</div>}
        {!error && !data && <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">Loading…</div>}
      </div>
      <footer className="border-t px-3 py-1 text-[11px] text-muted-foreground" data-testid="chart-attribution">
        Charting by{" "}
        <a className="underline" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView
        </a>{" "}
        Lightweight Charts™ (Apache-2.0)
      </footer>
    </div>
  );
}
