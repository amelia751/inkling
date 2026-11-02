import { useEffect, useMemo, useState } from "react";
import { WarningIcon as AlertTriangle } from "@studio/ui/icons";
import { fetchBodySize } from "@studio/renderers/io/niftiIO";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { cn } from "@studio/ui/utils";
import { labelNames } from "@studio/contracts/environment";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { useRuntime } from "@studio/plugin-ui-sdk/runtime";
import {
  cineConfig,
  cinePath,
  GOTO_COMMAND,
  groupCells,
  phaseOps,
  resolvePhases,
  RUNTIME,
  STRUCT_KEYS,
  STRUCT_SHORT,
  structuresOf,
  type CineCoverage,
  type CineGrid,
  type CinePlayhead,
  type PhaseMark,
  type RefSeg,
  type StructKey,
  type Structures,
} from "@plugins/cine/public";
import { computeMetrics, diceVsReference, mosteller, type CineMetrics, type DiceRow } from "../metrics";
import { MetricsConfigSchema } from "../config";
import { execute, newAnnotation, useHost } from "@studio/plugin-ui-sdk";

/**
 * Right-slot panel: ventricular function (EDV, ESV, SV, EF), LV mass, the LV volume curve
 * with an ED/ES suggestion, per-slice areas of the current frame, Dice against reference
 * segmentations and body size. Reads what the cine renderer publishes to the runtime
 * (grid, playhead, coverage, references); navigates with `studio.cine.commands.goTo`.
 */
export function CardiacMetricsPanel({ env, project, item, config: rawConfig }: PanelProps) {
  const config = useMemo(() => MetricsConfigSchema.parse(rawConfig), [rawConfig]);
  const cine = useMemo(() => cineConfig(env), [env]);
  const structs = useMemo(() => structuresOf(cine), [cine]);
  const labels = useMemo(() => labelNames(env.labels), [env.labels]);
  const grid = useRuntime<CineGrid>(item?.id, RUNTIME.grid);
  const coverage = useRuntime<CineCoverage>(item?.id, RUNTIME.coverage);
  const refs = useRuntime<RefSeg[]>(item?.id, RUNTIME.references);
  const playhead = useRuntime<CinePlayhead>(item?.id, RUNTIME.playhead);
  const annotations = useHost((s) => s.annotations);
  const [body, setBody] = useState<{ height: number | null; weight: number | null }>({ height: null, weight: null });
  const path = item && cinePath(item);
  useEffect(() => {
    let live = true;
    if (path) fetchBodySize(path, project.meta).then((b) => live && setBody(b));
    return () => {
      live = false;
    };
  }, [path, project.meta]);

  const { ed: edId, es: esId } = config.phases;
  const phases = useMemo(
    () => (item ? resolvePhases(annotations, item.id, item.assets, project.meta, [edId, esId]) : ({} as Record<string, PhaseMark | null>)),
    [annotations, item, project.meta, edId, esId],
  );
  const ed = phases[edId]?.frame ?? null, es = phases[esId]?.frame ?? null;
  const bsa = mosteller(body.height, body.weight);
  const metrics = useMemo(() => (coverage ? computeMetrics({ frames: coverage, ed, es, bsa }) : null), [coverage, ed, es, bsa]);
  const cells = useMemo(() => (item ? groupCells(annotations, item.id) : new Map()), [annotations, item]);
  const qa = useMemo(
    () => (grid && refs ? refs.map((r) => ({ phase: r.phase, frame: r.frame, rows: diceVsReference(cells, r.frame, r.volume.data, labels, structs, grid) })) : []),
    [refs, cells, labels, structs, grid],
  );

  if (!item || !metrics || !playhead) return <aside className="p-3 text-xs text-muted-foreground">Waiting for the cine…</aside>;

  const applySuggestion = () => {
    const s = metrics.suggested;
    if (!s) return;
    const all = useHost.getState().annotations;
    const ops = phaseOps(all, item.id, { [edId]: s.ed, [esId]: s.es }, (init) => newAnnotation({ itemId: item.id, label: structs.lv ?? labels[0] ?? "phase", ...init }));
    useHost.getState().batch(ops); // ED and ES change together as one undo step
  };

  return (
    <aside className="h-full overflow-y-auto" aria-label="Cardiac function">
      <MetricsPanel
        metrics={metrics}
        labels={labels}
        structs={structs}
        frame={playhead.frame}
        slice={playhead.slice}
        onFrame={(frame) => execute(GOTO_COMMAND, { frame })}
        phases={{ ed: phases[edId] ?? null, es: phases[esId] ?? null }}
        onApplySuggestion={applySuggestion}
        height={body.height}
        weight={body.weight}
        onBody={setBody}
        qa={qa}
      />
    </aside>
  );
}

interface Props {
  metrics: CineMetrics;
  labels: string[];
  structs: Structures;
  frame: number;
  slice: number;
  onFrame: (f: number) => void;
  phases: { ed: PhaseMark | null; es: PhaseMark | null };
  onApplySuggestion: () => void;
  height: number | null;
  weight: number | null;
  onBody: (b: { height: number | null; weight: number | null }) => void;
  qa: { phase: string; frame: number; rows: DiceRow[] }[];
}

const v = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !isFinite(x) ? "—" : x.toFixed(d));

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-2.5">
      <h3 className="mb-1.5 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

export function MetricsPanel({ metrics: m, labels, structs, frame, slice, onFrame, phases, onApplySuggestion, height, weight, onBody, qa }: Props) {
  const bsa = m.bsa;
  const idx = (x: number | null) => (x !== null && bsa ? x / bsa : null);
  const provisional = m.warnings.length > 0;
  const cur = m.frames[frame];
  const suggestionDiffers = m.suggested && (m.suggested.ed !== m.ed || m.suggested.es !== m.es);

  return (
    <div className="text-xs">
      <Section
        title="Function"
        aside={provisional ? <span className="normal-case tracking-normal text-warning">provisional</span> : <span className="normal-case tracking-normal text-positive">complete</span>}
      >
        <table className="w-full tnum">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-normal" />
              <th className="text-right font-normal">EDV</th>
              <th className="text-right font-normal">ESV</th>
              <th className="text-right font-normal">SV</th>
              <th className="text-right font-normal">EF</th>
            </tr>
          </thead>
          <tbody>
            {(["lv", "rv"] as const).map((k) => {
              const f = m[k];
              return (
                <tr key={k} className={cn(provisional && "text-foreground/80")}>
                  <td className="py-0.5">
                    <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: structs[k] ? labelColor(labels, structs[k]!) : undefined }} />
                    {STRUCT_SHORT[k]}
                  </td>
                  <td className="text-right">{v(f.edv)}</td>
                  <td className="text-right">{v(f.esv)}</td>
                  <td className="text-right">{v(f.sv)}</td>
                  <td className="text-right font-medium">{f.ef !== null ? `${v(f.ef, 0)}%` : "—"}</td>
                </tr>
              );
            })}
            {bsa && (
              <>
                {(["lv", "rv"] as const).map((k) => (
                  <tr key={`${k}i`} className="text-muted-foreground">
                    <td className="py-0.5">{STRUCT_SHORT[k]} /m²</td>
                    <td className="text-right">{v(idx(m[k].edv))}</td>
                    <td className="text-right">{v(idx(m[k].esv))}</td>
                    <td className="text-right">{v(idx(m[k].sv))}</td>
                    <td />
                  </tr>
                ))}
              </>
            )}
          </tbody>
        </table>
        <div className="mt-1.5 flex justify-between tnum">
          <span className="text-muted-foreground">LV mass (ED)</span>
          <span>
            {m.mass !== null ? `${v(m.mass)} g` : "—"}
            {m.mass !== null && bsa ? <span className="text-muted-foreground"> · {v(idx(m.mass))} g/m²</span> : null}
          </span>
        </div>
        {m.massEs !== null && m.mass !== null && (
          <div className="flex justify-between tnum text-muted-foreground">
            <span>LV mass (ES) check</span>
            <span>{v(m.massEs)} g</span>
          </div>
        )}
        <p className="mt-1 text-[10px] text-muted-foreground">mL, Simpson's discs (Σ area × slice spacing). Mass = MYO volume × 1.05 g/mL.</p>
        {m.warnings.length > 0 && (
          <ul className="mt-1.5 space-y-1">
            {m.warnings.map((w) => (
              <li key={w} className="flex gap-1.5 text-warning">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {w}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Volume over time">
        <VolumeCurve metrics={m} labels={labels} structs={structs} frame={frame} onFrame={onFrame} />
        <p className="text-[10px] text-muted-foreground">Hollow points: frames with missing slices (not joined).</p>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
          <span>ED {m.ed !== null ? `frame ${m.ed + 1}` : "—"} <span className="text-hint">({phases.ed?.source ?? "unset"})</span></span>
          <span>ES {m.es !== null ? `frame ${m.es + 1}` : "—"} <span className="text-hint">({phases.es?.source ?? "unset"})</span></span>
        </div>
        {suggestionDiffers && m.suggested && (
          <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md bg-generic px-2 py-1">
            <span>
              LV curve suggests ED {m.suggested.ed + 1}, ES {m.suggested.es + 1}
            </span>
            <button onClick={onApplySuggestion} className="rounded px-1.5 py-0.5 text-primary hover:bg-generic">
              Apply
            </button>
          </div>
        )}
      </Section>

      <Section title={`Frame ${frame + 1} areas (mm²)`}>
        {cur && cur.areas.size ? (
          <table className="w-full tnum">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-normal">Slice</th>
                {STRUCT_KEYS.map((k) => (
                  <th key={k} className="text-right font-normal">{STRUCT_SHORT[k]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...cur.areas.entries()].sort((a, b) => a[0] - b[0]).map(([z, a]) => (
                <tr key={z} className={cn(z === slice && "text-primary")}>
                  <td>{z + 1}</td>
                  {STRUCT_KEYS.map((k) => (
                    <td key={k} className="text-right">{a[k] ? a[k].toFixed(0) : "·"}</td>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-border text-foreground">
                <td>mL</td>
                {STRUCT_KEYS.map((k) => (
                  <td key={k} className="text-right">{v(cur.volume[k])}</td>
                ))}
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="text-muted-foreground">Nothing drawn on this frame yet.</p>
        )}
      </Section>

      {qa.length > 0 && (
        <Section title="QA vs reference (Dice)">
          {qa.map(({ phase, frame: f, rows }) => {
            const mean = (k: StructKey) => {
              const xs = rows.map((r) => r.dice[k]).filter((x): x is number => x !== null);
              return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
            };
            return (
              <div key={phase} className="mb-2 last:mb-0">
                <button onClick={() => onFrame(f)} className={cn("mb-0.5 text-left", f === frame ? "text-primary" : "text-foreground/80 hover:text-foreground")}>
                  {phase} · frame {f + 1}
                </button>
                {rows.length ? (
                  <table className="w-full tnum">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="text-left font-normal">Slice</th>
                        {STRUCT_KEYS.map((k) => (
                          <th key={k} className="text-right font-normal">{STRUCT_SHORT[k]}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.slice}>
                          <td>{r.slice + 1}</td>
                          {STRUCT_KEYS.map((k) => (
                            <td key={k} className={cn("text-right", r.dice[k] !== null && r.dice[k]! < 0.8 && "text-warning")}>
                              {r.dice[k] !== null ? r.dice[k]!.toFixed(2) : "·"}
                            </td>
                          ))}
                        </tr>
                      ))}
                      <tr className="border-t border-border text-foreground">
                        <td>mean</td>
                        {STRUCT_KEYS.map((k) => (
                          <td key={k} className="text-right">{mean(k) !== null ? mean(k)!.toFixed(2) : "—"}</td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                ) : (
                  <p className="text-muted-foreground">Draw on this frame to compare with the reference.</p>
                )}
              </div>
            );
          })}
        </Section>
      )}

      <Section title="Body size">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">H</span>
            <input
              type="number"
              value={height ?? ""}
              onChange={(e) => onBody({ height: e.target.value ? +e.target.value : null, weight })}
              className="w-14 rounded border border-border bg-transparent px-1 py-0.5 tnum"
              aria-label="Height in cm"
            />
            <span className="text-muted-foreground">cm</span>
          </label>
          <label className="flex items-center gap-1">
            <span className="text-muted-foreground">W</span>
            <input
              type="number"
              value={weight ?? ""}
              onChange={(e) => onBody({ height, weight: e.target.value ? +e.target.value : null })}
              className="w-14 rounded border border-border bg-transparent px-1 py-0.5 tnum"
              aria-label="Weight in kg"
            />
            <span className="text-muted-foreground">kg</span>
          </label>
        </div>
        <p className="mt-1 tnum text-muted-foreground">BSA (Mosteller) {bsa ? `${bsa.toFixed(2)} m²` : "—"}</p>
      </Section>
    </div>
  );
}

function VolumeCurve({ metrics: m, labels, structs, frame, onFrame }: { metrics: CineMetrics; labels: string[]; structs: Structures; frame: number; onFrame: (f: number) => void }) {
  const W = 248, H = 96, L = 28, R = 4, T = 6, B = 14;
  const n = m.frames.length;
  const series = (["lv", "rv"] as const).map((k) => ({
    k,
    pts: m.frames.filter((f) => f.volume[k] !== null).map((f) => [f.frame, f.volume[k]!, f.status[k] === "complete"] as const),
  }));
  const max = Math.max(10, ...series.flatMap((s) => s.pts.map((p) => p[1])));
  const x = (f: number) => L + (f / Math.max(1, n - 1)) * (W - L - R);
  const y = (vol: number) => T + (1 - vol / max) * (H - T - B);
  const empty = series.every((s) => !s.pts.length);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full cursor-pointer select-none"
      role="img"
      aria-label="LV and RV volume over the cardiac cycle"
      onClick={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const fx = ((e.clientX - r.left) / r.width) * W;
        onFrame(Math.max(0, Math.min(n - 1, Math.round(((fx - L) / (W - L - R)) * (n - 1)))));
      }}
    >
      <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="currentColor" strokeOpacity={0.2} />
      <text x={L - 3} y={T + 4} textAnchor="end" fontSize={8} fill="currentColor" fillOpacity={0.5}>{max.toFixed(0)}</text>
      <text x={L - 3} y={H - B} textAnchor="end" fontSize={8} fill="currentColor" fillOpacity={0.5}>0</text>
      <text x={W - R} y={H - 3} textAnchor="end" fontSize={8} fill="currentColor" fillOpacity={0.5}>frame</text>
      <text x={2} y={H / 2} fontSize={8} fill="currentColor" fillOpacity={0.5}>mL</text>
      {([["ED", m.ed], ["ES", m.es]] as const).map(([name, f]) =>
        f !== null ? (
          <g key={name}>
            <line x1={x(f)} x2={x(f)} y1={T} y2={H - B} stroke="hsl(var(--primary))" strokeDasharray="2 2" strokeOpacity={0.8} />
            <text x={x(f) + 2} y={H - 3} fontSize={8} fill="hsl(var(--primary))">{name}</text>
          </g>
        ) : null,
      )}
      <line x1={x(frame)} x2={x(frame)} y1={T} y2={H - B} stroke="currentColor" strokeOpacity={0.35} />
      {series.map(({ k, pts }) => {
        const color = structs[k] ? labelColor(labels, structs[k]!) : "currentColor";
        return (
          <g key={k}>
            {pts.filter((p) => p[2]).length > 1 && (
              <polyline points={pts.filter((p) => p[2]).map(([f, vol]) => `${x(f)},${y(vol)}`).join(" ")} fill="none" stroke={color} strokeWidth={1.5} />
            )}
            {pts.map(([f, vol, complete]) => (
              <circle key={f} cx={x(f)} cy={y(vol)} r={f === frame ? 2.75 : 1.75} fill={complete ? color : "none"} stroke={color} strokeWidth={complete ? 0 : 1}>
                <title>{`${STRUCT_SHORT[k]} frame ${f + 1}: ${vol.toFixed(1)} mL${complete ? "" : " (incomplete)"}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
      {empty && (
        <text x={(W + L) / 2} y={H / 2} textAnchor="middle" fontSize={9} fill="currentColor" fillOpacity={0.5}>
          Contour LV/RV on several frames
        </text>
      )}
    </svg>
  );
}
