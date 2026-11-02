import { useMemo } from "react";
import { cn } from "@studio/ui/utils";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { codeName, MeasurementsConfigSchema, statementsOf, stripConfig, type Statement } from "../config";
import { measure, ms } from "../measure";
import { kindOf, rangeOf, rhythmOf } from "../model";
import { isEditable, newAnnotation, useHost, visibleFor } from "@studio/plugin-ui-sdk";

function Row({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5" title={hint}>
      <dt className="text-canvas-foreground/60">{k}</dt>
      <dd className="tnum text-right">{v}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-white/10 px-3 py-2.5">
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-canvas-foreground/50">{title}</h3>
      {children}
    </section>
  );
}

/**
 * `studio.timeseries.panels.measurements` (slot right): rate and RR from instants, wave
 * intervals (with `ecg` config), track episodes, and record-level statements from the
 * environment's `multiple` Choices group (toggled as class annotations carrying the class's
 * code attribute; codes listed in the item's source label can be adopted).
 */
export function MeasurementsPanel({ env, item, config }: PanelProps) {
  const cfg = stripConfig(env);
  const pc = useMemo(() => MeasurementsConfigSchema.parse(config ?? {}), [config]);
  const statements = useMemo(() => statementsOf(env, pc), [env, pc]);
  const annotations = useHost((s) => s.annotations);
  const hiddenLabels = useHost((s) => s.hiddenLabels);
  const add = useHost((s) => s.add);
  const remove = useHost((s) => s.remove);
  const select = useHost((s) => s.select);
  const lockedLabels = useHost((s) => s.lockedLabels);
  const itemId = item?.id;
  const all = useMemo(() => annotations.filter((a) => a.itemId === itemId), [annotations, itemId]);
  const anns = useMemo(() => (itemId ? visibleFor(annotations, itemId, hiddenLabels) : []), [annotations, itemId, hiddenLabels]);
  const m = useMemo(() => measure(anns), [anns]);
  if (!item || !itemId) return null;

  const classes = all.filter((a) => a.geometry.type === "class");
  const episodes = anns.filter((a) => kindOf(a, cfg.track.channel) === "rhythm").sort((a, b) => rangeOf(a.geometry)![0] - rangeOf(b.geometry)![0]);
  const dx = String((item.assets[0] as { dx?: string } | undefined)?.dx ?? item.sourceLabel ?? "");
  const byCode = (code: string) => statements.items.find((s) => s.code === code);
  const source = dx
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => ({ code: c, s: byCode(c) }));

  const has = (name: string) => classes.find((a) => a.label === name);
  const toggle = (s: Statement, origin: "expert" | "source") => {
    const hit = has(s.id);
    if (hit) {
      if (isEditable(hit, lockedLabels)) remove(hit.id);
      return;
    }
    add(newAnnotation({ itemId, label: s.id, geometry: { type: "class" }, attributes: { ...(s.code !== undefined ? { [pc.codeAttribute]: s.code } : {}), source: origin === "source" ? "dataset-dx" : "expert" } }));
  };
  const system = pc.codeSystem ? ` (${pc.codeSystem})` : "";

  return (
    <aside className="flex h-full flex-col overflow-y-auto bg-canvas text-xs text-canvas-foreground" aria-label={pc.label}>
      <Section title={cfg.ecg ? "Rhythm" : "Events"}>
        <dl>
          <Row k={cfg.ecg ? "Heart rate" : "Rate"} v={m.hr ? `${Math.round(m.hr)} ${cfg.ecg ? "bpm" : "/min"}` : "—"} hint="Mean of the intervals between instants" />
          <Row k="RR mean" v={ms(m.rrMean)} />
          <Row k="RR SD" v={ms(m.rrSd)} hint="Standard deviation of RR intervals (SDNN over the record)" />
          <Row k={cfg.ecg ? "Beats" : "Instants"} v={String(m.beats)} />
        </dl>
        {m.codes.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {m.codes.map(([code, n]) => (
              <span key={code} title={codeName(cfg.instantCodes, code)} className="tnum rounded bg-white/10 px-1.5 py-0.5">
                <b className="font-semibold">{code}</b> {n}
              </span>
            ))}
          </div>
        )}
        {m.unreviewed > 0 && (
          <p className="mt-2 rounded bg-prov-ai/15 px-2 py-1 text-prov-ai">
            {m.unreviewed} AI suggestion{m.unreviewed === 1 ? "" : "s"} to review · Tab next · Enter accept · Del reject
          </p>
        )}
      </Section>
      {cfg.ecg && (
        <Section title="Intervals (from waves)">
          <dl>
            <Row k="P duration" v={ms(m.p)} />
            <Row k="PR" v={ms(m.pr)} hint="P onset → QRS onset on the same lead" />
            <Row k="QRS" v={ms(m.qrs)} />
            <Row k="QT" v={ms(m.qt)} hint="QRS onset → T offset on the same lead" />
            <Row k="QTc Bazett" v={ms(m.qtcB)} hint="QT / √RR, RR = mean RR from beats" />
            <Row k="QTc Fridericia" v={ms(m.qtcF)} hint="QT / ∛RR" />
          </dl>
          <p className="mt-1 text-canvas-foreground/50">
            Waves: P {m.waves.P} · QRS {m.waves.QRS} · T {m.waves.T}
          </p>
        </Section>
      )}
      <Section title={`${cfg.track.label} episodes`}>
        {episodes.length === 0 ? (
          <p className="text-canvas-foreground/50">None. Use the {cfg.track.label.toLowerCase()} tool on the track under the {cfg.channelNoun}s.</p>
        ) : (
          <ul className="space-y-0.5">
            {episodes.map((a) => {
              const [start, end] = rangeOf(a.geometry)!;
              const code = rhythmOf(a);
              return (
                <li key={a.id}>
                  <button onClick={() => select(a.id)} className="flex w-full justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10">
                    <span title={codeName(cfg.trackCodes, code)}>{code}</span>
                    <span className="tnum text-canvas-foreground/60">
                      {start.toFixed(2)}–{end.toFixed(2)} s
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {statements.items.length > 0 && (
        <Section title="Record statements">
          {source.length > 0 && (
            <div className="mb-2">
              <p className="mb-1 text-canvas-foreground/50">Source Dx{system} — click to adopt</p>
              <div className="flex flex-wrap gap-1">
                {source.map(({ code, s }) => (
                  <button
                    key={code}
                    disabled={!s}
                    onClick={() => s && toggle(s, "source")}
                    title={s ? `${s.id} (${code})` : `Unmapped code ${code}`}
                    className={cn("rounded border border-dashed border-white/25 px-1.5 py-0.5", s && has(s.id) ? "border-solid bg-primary text-primary-foreground" : "hover:bg-white/10", !s && "opacity-60")}
                  >
                    {s?.name ?? code}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-1">
            {statements.items.map((s) => {
              const on = !!has(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => toggle(s, "expert")}
                  aria-pressed={on}
                  title={`${s.id}${s.code ? ` · ${pc.codeSystem ?? pc.codeAttribute} ${s.code}` : ""}`}
                  className={cn("rounded px-1.5 py-0.5 transition-colors", on ? "bg-primary text-primary-foreground" : "bg-white/5 text-canvas-foreground/75 hover:bg-white/10")}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
          {classes.length > 0 && <p className="mt-2 text-canvas-foreground/60">{classes.map((a) => a.label).join(" · ")}</p>}
        </Section>
      )}
    </aside>
  );
}
