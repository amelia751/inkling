import { cn } from "@/lib/utils";
import { isEditable, newAnnotation, useStudio } from "@/stores/studio";
import type { Annotation } from "@/types";
import { beatCodeName, rhythmName, STATEMENTS, statementForCode } from "./codes";
import { ms, type Measurements } from "./measure";

interface Props {
  itemId: string;
  /** Visible annotations of this item. */
  anns: Annotation[];
  /** All annotations of this item, hidden ones included (statements toggle against these). */
  all: Annotation[];
  m: Measurements;
  dx: string;
  onJump: (a: Annotation) => void;
}

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

/** Measurements, rhythm episodes and record-level statements for the open ECG. */
export function SidePanel({ itemId, anns, all, m, dx, onJump }: Props) {
  const add = useStudio((s) => s.add);
  const remove = useStudio((s) => s.remove);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const statements = all.filter((a) => a.geometry.type === "class");
  const rhythms = anns.filter((a) => a.geometry.type === "rhythm").sort((a, b) => (a.geometry as { start: number }).start - (b.geometry as { start: number }).start);
  const source = dx
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => ({ code: c, s: statementForCode(c) }));

  const has = (name: string) => statements.find((a) => a.label === name);
  const toggle = (name: string, snomed: string, origin: "expert" | "source") => {
    const hit = has(name);
    if (hit) {
      if (isEditable(hit, lockedLabels)) remove(hit.id);
      return;
    }
    add(newAnnotation({ itemId, label: name, geometry: { type: "class" }, attributes: { snomed, source: origin === "source" ? "dataset-dx" : "expert" } }));
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-l border-white/10 text-xs" aria-label="ECG measurements">
      <Section title="Rhythm">
        <dl>
          <Row k="Heart rate" v={m.hr ? `${Math.round(m.hr)} bpm` : "—"} hint="Mean of RR intervals between beat annotations" />
          <Row k="RR mean" v={ms(m.rrMean)} />
          <Row k="RR SD" v={ms(m.rrSd)} hint="Standard deviation of RR intervals (SDNN over the record)" />
          <Row k="Beats" v={String(m.beats)} />
        </dl>
        {m.codes.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {m.codes.map(([code, n]) => (
              <span key={code} title={beatCodeName(code)} className="tnum rounded bg-white/10 px-1.5 py-0.5">
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
      <Section title="Rhythm episodes">
        {rhythms.length === 0 ? (
          <p className="text-canvas-foreground/50">None. Use the rhythm tool (Y) on the track under the leads.</p>
        ) : (
          <ul className="space-y-0.5">
            {rhythms.map((a) => {
              const g = a.geometry as { start: number; end: number; rhythm: string };
              return (
                <li key={a.id}>
                  <button onClick={() => onJump(a)} className="flex w-full justify-between gap-2 rounded px-1 py-0.5 text-left hover:bg-white/10">
                    <span title={rhythmName(g.rhythm)}>{g.rhythm}</span>
                    <span className="tnum text-canvas-foreground/60">
                      {g.start.toFixed(2)}–{g.end.toFixed(2)} s
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section title="Record statements">
        {source.length > 0 && (
          <div className="mb-2">
            <p className="mb-1 text-canvas-foreground/50">Source Dx (SNOMED CT) — click to adopt</p>
            <div className="flex flex-wrap gap-1">
              {source.map(({ code, s }) => (
                <button
                  key={code}
                  disabled={!s}
                  onClick={() => s && toggle(s.name, s.snomed, "source")}
                  title={s ? `${s.name} (${code})` : `Unmapped SNOMED code ${code}`}
                  className={cn("rounded border border-dashed border-white/25 px-1.5 py-0.5", s && has(s.name) ? "border-solid bg-primary text-primary-foreground" : "hover:bg-white/10", !s && "opacity-60")}
                >
                  {s?.abbr ?? code}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {STATEMENTS.map((s) => {
            const on = !!has(s.name);
            return (
              <button
                key={s.snomed}
                onClick={() => toggle(s.name, s.snomed, "expert")}
                aria-pressed={on}
                title={`${s.name} · SNOMED ${s.snomed}`}
                className={cn("rounded px-1.5 py-0.5 transition-colors", on ? "bg-primary text-primary-foreground" : "bg-white/5 text-canvas-foreground/75 hover:bg-white/10")}
              >
                {s.abbr}
              </button>
            );
          })}
        </div>
        {statements.length > 0 && <p className="mt-2 text-canvas-foreground/60">{statements.map((a) => a.label).join(" · ")}</p>}
      </Section>
    </aside>
  );
}
