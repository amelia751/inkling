import type { ReactNode } from "react";
import { HideIcon, ShowIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * Overlay legend on the dark canvas: a header line (position, phase…), one row per label
 * that toggles its visibility, and an optional note. Domain-neutral: colours, header and
 * note come in as props.
 */
export function Legend({
  labels,
  hidden,
  onToggle,
  colorOf,
  header,
  note,
}: {
  labels: string[];
  hidden: string[];
  onToggle: (label: string) => void;
  /** CSS colour of a label at an alpha. */
  colorOf: (label: string, alpha: number) => string;
  header?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="absolute right-3 top-3 w-52 rounded-md bg-black/60 px-2 py-1.5 text-xs">
      {header && <div className="mb-1 flex justify-between tnum text-canvas-foreground/70">{header}</div>}
      {labels.map((l) => (
        <button key={l} onClick={() => onToggle(l)} className="flex w-full items-center gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-white/10" title={hidden.includes(l) ? "Show" : "Hide"}>
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colorOf(l, hidden.includes(l) ? 0.3 : 1) }} />
          <span className={cn("flex-1 capitalize", hidden.includes(l) && "text-canvas-foreground/40 line-through")}>{l}</span>
          {hidden.includes(l) ? <HideIcon className="h-3 w-3 opacity-60" /> : <ShowIcon className="h-3 w-3 opacity-60" />}
        </button>
      ))}
      {note && <p className="mt-1 border-t border-white/10 pt-1 text-[10px] leading-snug text-canvas-foreground/55">{note}</p>}
    </div>
  );
}
