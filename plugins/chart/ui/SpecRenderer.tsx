import { useEffect, useMemo, useRef, useState } from "react";
import embed from "vega-embed";
import type { RendererProps } from "@studio/plugin-ui-sdk/module";
import { SpecConfigSchema } from "./config";
import { withRows } from "./data";
import { useTable } from "./useTable";

/** A Vega-Lite spec from config; the item's rows become `data.values` when the spec has none. */
export function SpecRenderer({ item, config, runtime }: RendererProps) {
  const cfg = useMemo(() => SpecConfigSchema.parse(config), [config]);
  const { table, error } = useTable(item);
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    const el = host.current;
    if (!el || !table) return;
    let done = false;
    let finalize: (() => void) | undefined;
    const spec = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", width: "container", height: "container", autosize: { type: "fit", contains: "padding" }, ...withRows(cfg.spec, table.rows) };
    setFailed(undefined);
    embed(el, spec as never, { actions: false, renderer: "svg", mode: "vega-lite" })
      .then((r) => {
        if (done) return r.finalize();
        finalize = () => r.finalize();
        runtime.publish("chartInfo", { mode: "spec", rows: table.rows.length });
      })
      .catch((e: unknown) => setFailed(String(e instanceof Error ? e.message : e)));
    return () => {
      done = true;
      finalize?.();
    };
  }, [table, cfg.spec, runtime]);

  const message = error ?? failed;
  return (
    <div className="relative h-full w-full bg-background p-3" data-testid="chart-spec">
      <div ref={host} className="h-full w-full" />
      {message && <div className="absolute inset-0 grid place-items-center text-sm text-destructive">{message}</div>}
    </div>
  );
}
