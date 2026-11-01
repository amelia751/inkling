import { useState } from "react";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { DeleteIcon, TodoIcon } from "@studio/ui/icons";
import { ScrollArea } from "@studio/ui/ui/scroll-area";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { cn } from "@studio/ui/utils";
import { describeGeometry } from "@/extension-host/describe";
import { labelNames } from "@studio/contracts/environment";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { useStudio } from "@/studio/stores/studio";
import { ProvenanceBadge } from "./provenance";

/** `inkling.core.panels.review`: every annotation with provenance, and the items with none yet. */
export function ReviewPanel({ env, items }: PanelProps) {
  const [filter, setFilter] = useState<"all" | "unlabeled">("all");
  const annotations = useStudio((s) => s.annotations);
  const setItemIndex = useStudio((s) => s.setItemIndex);
  const remove = useStudio((s) => s.remove);
  const select = useStudio((s) => s.select);
  const labels = labelNames(env.labels);
  const indexOf = (id: string) => items.findIndex((i) => i.id === id);
  const annotated = new Set(annotations.map((a) => a.itemId));
  const unlabeled = items.filter((i) => !annotated.has(i.id));

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 px-2 pt-2">
        {(["all", "unlabeled"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn("rounded-md px-2 py-1 text-xs transition-colors", filter === f ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-[var(--bg-tertiary)]")}
          >
            {f === "all" ? `Annotations · ${annotations.length}` : `Unlabeled · ${unlabeled.length}`}
          </button>
        ))}
      </div>
      <ScrollArea className="min-h-0 flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block">
        <div className="space-y-1 p-2">
          {filter === "all" &&
            [...annotations].reverse().map((a) => (
              <div key={a.id} className="group rounded-md border border-[var(--border-color)] p-2 text-sm hover:bg-[var(--bg-tertiary)]">
                <button
                  className="w-full text-left"
                  onClick={(e) => {
                    if (indexOf(a.itemId) !== useStudio.getState().itemIndex) setItemIndex(indexOf(a.itemId));
                    if (e.shiftKey || e.metaKey || e.ctrlKey) useStudio.getState().toggleSelect(a.id);
                    else select(a.id);
                  }}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: labelColor(labels, a.label) }} />
                    <span className="truncate font-medium capitalize">{a.label}</span>
                    <span className="ml-auto"><ProvenanceBadge provenance={a.provenance} /></span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {items[indexOf(a.itemId)]?.name} · {describeGeometry(a, env)}
                  </div>
                </button>
                <button
                  onClick={() => remove(a.id)}
                  className="mt-1 hidden items-center gap-1 text-xs text-muted-foreground hover:text-state-fail group-hover:flex"
                >
                  <DeleteIcon className="h-3 w-3" /> Remove
                </button>
              </div>
            ))}
          {filter === "all" && !annotations.length && (
            <EmptyState size="s" art="annotation" title="No annotations yet" description="Pick a label and draw on the canvas." />
          )}
          {filter === "unlabeled" &&
            unlabeled.map((i) => (
              <button key={i.id} onClick={() => setItemIndex(indexOf(i.id))} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)]">
                <TodoIcon className="h-3.5 w-3.5 text-muted-foreground/50" />
                <span className="truncate">{i.name}</span>
              </button>
            ))}
        </div>
      </ScrollArea>
    </div>
  );
}
