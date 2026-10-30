import { memo, useEffect, useRef } from "react";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { cn } from "@studio/ui/utils";
import type { Volume } from "@studio/renderers/io/nifti";
import { cellKey, STRUCT_KEYS, STRUCT_SHORT, type Cell, type FrameMetrics, type StructKey, type Structures } from "../model";
import { renderThumb } from "../renderer/render";

const THUMB_W = 48;

interface Props {
  cine: Volume;
  slice: number;
  frame: number;
  onPick: (slice: number, frame: number) => void;
  cells: Map<string, Cell>;
  labels: string[];
  structs: Structures;
  frameMetrics: FrameMetrics[];
  /** Highlighted frames (key frames such as ED / ES): frame → short name. */
  marked: Map<number, string>;
  window: [number, number];
}

/**
 * Slice × frame matrix (Segment / cvi42 style): one thumbnail per slice (rows) and frame
 * (columns). Dots show which structures (or, with no structure roles configured, which
 * labels) are drawn in each cell; the column header shows per-structure completeness for
 * that frame (filled = complete, ring = gaps). Key frames are highlighted.
 */
export const SliceFrameMatrix = memo(function SliceFrameMatrix({ cine, slice, frame, onPick, cells, labels, structs, frameMetrics, marked, window: win }: Props) {
  const [nx, ny, nz] = cine.dims;
  const thumbH = Math.round((THUMB_W * ny * cine.spacing[1]) / (nx * cine.spacing[0]));
  const canvases = useRef(new Map<string, HTMLCanvasElement>());

  // Draw thumbnails lazily, nearest to the current position first, a few per task.
  useEffect(() => {
    const order: [number, number][] = [];
    for (let z = 0; z < nz; z++) for (let f = 0; f < cine.frames; f++) order.push([z, f]);
    order.sort((a, b) => Math.abs(a[0] - slice) * 4 + Math.abs(a[1] - frame) - (Math.abs(b[0] - slice) * 4 + Math.abs(b[1] - frame)));
    let i = 0;
    let handle = 0;
    const work = () => {
      const end = Math.min(order.length, i + 12);
      for (; i < end; i++) {
        const [z, f] = order[i];
        const c = canvases.current.get(cellKey(z, f));
        if (c) renderThumb(cine, z, f, win[0], win[1], c);
      }
      if (i < order.length) handle = window.setTimeout(work, 0);
    };
    handle = window.setTimeout(work, 0);
    return () => clearTimeout(handle);
    // Position only orders the work; regenerate when the data or window changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cine, win[0], win[1], nz]);

  const frames = Array.from({ length: cine.frames }, (_, f) => f);
  const roles = STRUCT_KEYS.filter((k) => structs[k]);
  // Dots per cell: structure roles in RV, MYO, LV order, else every label.
  const tracked: { key: string; label: string; short: string }[] = roles.length
    ? roles.map((k: StructKey) => ({ key: k, label: structs[k]!, short: STRUCT_SHORT[k] }))
    : labels.map((l) => ({ key: l, label: l, short: l }));
  return (
    <div className="overflow-auto">
      <table className="border-separate border-spacing-0.5 text-[10px] leading-none">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-background" />
            {frames.map((f) => {
              const fm = frameMetrics[f];
              const phase = marked.get(f) ?? null;
              return (
                <th key={f} className={cn("px-0 pb-1 font-normal", phase && "text-primary")}>
                  <button onClick={() => onPick(slice, f)} className="flex w-full flex-col items-center gap-0.5" title={`Frame ${f + 1}${phase ? ` (${phase})` : ""}`}>
                    <span className={cn("tnum", f === frame ? "font-semibold text-foreground" : "text-muted-foreground", phase && "text-primary")}>{phase ?? f + 1}</span>
                    <span className="flex gap-px">
                      {STRUCT_KEYS.map((k) =>
                        structs[k] ? (
                          <span
                            key={k}
                            title={`${STRUCT_SHORT[k]}: ${fm?.status[k] ?? "empty"}`}
                            className="h-1.5 w-1.5 rounded-[1px]"
                            style={{
                              background: fm?.status[k] === "complete" ? labelColor(labels, structs[k]!) : "transparent",
                              boxShadow: fm?.status[k] === "partial" ? `inset 0 0 0 1px ${labelColor(labels, structs[k]!)}` : fm?.status[k] === "empty" ? "inset 0 0 0 1px var(--color-border)" : undefined,
                            }}
                          />
                        ) : null,
                      )}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: nz }, (_, z) => (
            <tr key={z}>
              <th className={cn("sticky left-0 z-10 bg-background pr-1 text-right font-normal tnum", z === slice ? "text-foreground" : "text-muted-foreground")}>{z + 1}</th>
              {frames.map((f) => {
                const cell = cells.get(cellKey(z, f));
                const present = tracked.filter((t) => cell && (cell.contours.some((c) => c.label === t.label) || cell.masks.some((m) => m.label === t.label)));
                const current = z === slice && f === frame;
                const phaseCol = marked.has(f);
                return (
                  <td key={f} className="p-0">
                    <button
                      onClick={() => onPick(z, f)}
                      className={cn(
                        "relative block overflow-hidden rounded-[3px] outline-offset-0",
                        current ? "outline outline-2 outline-primary" : phaseCol ? "outline outline-1 outline-primary/50" : "hover:outline hover:outline-1 hover:outline-border-hover",
                      )}
                      style={{ width: THUMB_W, height: thumbH }}
                      title={`Slice ${z + 1}, frame ${f + 1}${present.length ? ` · ${present.map((t) => t.short).join(", ")}` : ""}`}
                    >
                      <canvas
                        width={THUMB_W}
                        height={thumbH}
                        ref={(el) => {
                          const k = cellKey(z, f);
                          if (el) canvases.current.set(k, el);
                          else canvases.current.delete(k);
                        }}
                        className={cn("block", !present.length && "opacity-70")}
                      />
                      {present.length > 0 && (
                        <span className="absolute bottom-0.5 left-0.5 flex gap-px">
                          {present.map((t) => (
                            <span key={t.key} className="h-1.5 w-1.5 rounded-full ring-1 ring-black/60" style={{ background: labelColor(labels, t.label) }} />
                          ))}
                        </span>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
