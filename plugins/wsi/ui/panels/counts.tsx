import { useMemo } from "react";
import { regionArea, regionOf } from "@studio/renderers/overlay2d/regions";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { labelNames } from "@studio/contracts/environment";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { useRuntime } from "@studio/plugin-ui-sdk/runtime";
import { countPoints } from "../measure";
import { useHost } from "@studio/plugin-ui-sdk";

const total = (m: Map<string, number>) => [...m.values()].reduce((s, n) => s + n, 0);

/**
 * `studio.wsi.panels.counts` (slot right): QuPath-style point counts per class on the
 * current slide, and inside the selected region with density in points/mm² when the
 * renderer has published `mpp`.
 */
export function CountsPanel({ env, item }: PanelProps) {
  const itemId = item?.id ?? "";
  const labels = labelNames(env.labels);
  const mpp = useRuntime<number | null>(item?.id, "mpp") ?? null;
  const annotations = useHost((s) => s.annotations);
  const selectedId = useHost((s) => s.selectedId);
  const selected = annotations.find((a) => a.id === selectedId && a.itemId === itemId);
  const geometry = selected?.geometry;
  const region = useMemo(() => (geometry ? regionOf(geometry) : null), [geometry]);
  const all = useMemo(() => countPoints(annotations, itemId, null), [annotations, itemId]);
  const inside = useMemo(() => (region ? countPoints(annotations, itemId, region) : null), [annotations, itemId, region]);
  if (!item) return null;
  const areaMm2 = region && mpp ? regionArea(region) * mpp * mpp * 1e-6 : 0;
  const classes = [...new Set([...labels, ...all.keys()])];
  return (
    <div className="space-y-2 p-3 text-sm" data-testid="point-counts">
      <div className="flex justify-between font-medium">
        <span>Points</span>
        <span className="tnum">{total(all)}</span>
      </div>
      <div>
        {classes.map((l) => (
          <div key={l} className="flex items-center justify-between py-0.5 text-[var(--text-secondary)]">
            <span className="flex items-center gap-1.5 capitalize">
              <span className="h-2 w-2 rounded-full" style={{ background: labelColor(labels, l) }} />
              {l}
            </span>
            <span className="tnum">{all.get(l) ?? 0}</span>
          </div>
        ))}
      </div>
      {inside && selected && total(inside) > 0 && (
        <div className="border-t border-[var(--border-color)] pt-2">
          <div className="mb-0.5 flex justify-between font-medium">
            <span className="truncate">In selected {selected.label}</span>
            <span className="tnum">{total(inside)}</span>
          </div>
          {[...inside].map(([l, n]) => (
            <div key={l} className="flex justify-between py-0.5 text-[var(--text-secondary)]">
              <span className="capitalize">{l}</span>
              <span className="tnum">
                {n}
                {areaMm2 > 0 && <span className="ml-1 text-muted-foreground">({Math.round(n / areaMm2).toLocaleString()}/mm²)</span>}
              </span>
            </div>
          ))}
          {areaMm2 > 0 && (
            <div className="flex justify-between pt-0.5 text-muted-foreground">
              <span>Density</span>
              <span className="tnum">{Math.round(total(inside) / areaMm2).toLocaleString()} /mm²</span>
            </div>
          )}
        </div>
      )}
      {total(all) === 0 && <p className="text-xs text-muted-foreground">Pick the Points tool and click cells to count them per class. Select a region to see counts and density inside it.</p>}
    </div>
  );
}
