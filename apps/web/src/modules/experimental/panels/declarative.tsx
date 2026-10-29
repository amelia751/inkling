import { useStudio } from "@/stores/studio";
import type { PanelProps } from "@/platform/module";
import { useRuntimeVersion } from "@/platform/runtime";
import type * as z from "zod";
import { selectValue, type Selector } from "../bridge";
import type { DeclarativeConfig } from "../manifest";

type Config = z.infer<typeof DeclarativeConfig>;
type Binding = string | number | { runtime: string } | { store: Selector };

const fmt = (v: unknown) => (typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)) : v === undefined || v === null ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Tier 2: renders agent-written JSON blocks. Values come only from the whitelisted bindings. */
export function DeclarativePanel({ items, item, config }: PanelProps) {
  const cfg = config as Config;
  const runtimeValues = useRuntimeVersion(item?.id);
  const s = useStudio();
  const value = (b: Binding): unknown =>
    typeof b === "object" ? ("runtime" in b ? runtimeValues?.[b.runtime] : selectValue(b.store, s, items, item)) : b;

  return (
    <aside className="flex h-full flex-col overflow-y-auto bg-[var(--bg-primary)] text-sm" aria-label={cfg.title} data-testid="agent-declarative-panel">
      <div className="flex h-10 shrink-0 items-center border-b border-[var(--border-color)] px-3 font-medium">{cfg.title}</div>
      <div className="space-y-3 p-3">
        {cfg.blocks.map((b, i) => {
          switch (b.type) {
            case "text":
              return <p key={i} className="text-muted-foreground">{b.text}</p>;
            case "stat":
              return (
                <div key={i} className="flex items-baseline justify-between">
                  <span className="text-muted-foreground">{b.label}</span>
                  <span className="tnum font-semibold" data-testid="agent-stat">{fmt(value(b.value as Binding))}{b.unit ? ` ${b.unit}` : ""}</span>
                </div>
              );
            case "list": {
              const v = value(b.items as Binding);
              const rows: [string, unknown][] = Array.isArray(v) ? v.map((x, j) => [String(j + 1), x]) : v && typeof v === "object" ? Object.entries(v) : [];
              return (
                <section key={i}>
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">{b.label}</h3>
                  <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
                    {rows.map(([k, x]) => (
                      <div key={k} className="contents">
                        <dt className="truncate">{k}</dt>
                        <dd className="tnum text-right">{fmt(x)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              );
            }
            case "progress": {
              const v = Number(value(b.value as Binding)) || 0, max = Number(value(b.max as Binding)) || 0;
              const pct = max > 0 ? Math.min(100, Math.round((v / max) * 100)) : 0;
              return (
                <div key={i}>
                  <div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">{b.label}</span><span className="tnum">{fmt(v)} / {fmt(max)}</span></div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-generic-accent" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={b.label}>
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            }
          }
        })}
      </div>
    </aside>
  );
}
