import { useMemo, useState } from "react";
import { DoneIcon, SearchIcon, TodoIcon } from "@studio/studio-ui/icons";
import { Input } from "@studio/studio-ui/ui/input";
import { ScrollArea } from "@studio/studio-ui/ui/scroll-area";
import { cn } from "@studio/studio-ui/utils";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { useStudio } from "@/studio/stores/studio";
import type { StudioItem } from "@studio/plugin-contracts/types";

/** `inkling.core.panels.files`: the project's items by group, with per-group progress and a filter. */
export function FilesPanel({ items }: PanelProps) {
  const [query, setQuery] = useState("");
  const itemIndex = useStudio((s) => s.itemIndex);
  const setItemIndex = useStudio((s) => s.setItemIndex);
  const annotations = useStudio((s) => s.annotations);
  const done = useMemo(() => new Set(annotations.map((a) => a.itemId)), [annotations]);

  const groups = useMemo(() => {
    const out = new Map<string, { item: StudioItem; index: number }[]>();
    items.forEach((item, index) => {
      if (query && !item.name.toLowerCase().includes(query.toLowerCase())) return;
      out.set(item.group, [...(out.get(item.group) ?? []), { item, index }]);
    });
    return [...out.entries()];
  }, [items, query]);

  return (
    <div className="flex h-full flex-col">
      <div className="relative px-2 pt-2">
        <SearchIcon className="absolute left-4 top-1/2 mt-1 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter files" className="h-8 pl-7 text-sm" />
      </div>
      <ScrollArea className="min-h-0 flex-1 [&>[data-radix-scroll-area-viewport]>div]:!block">
        <div className="space-y-3 p-2">
          {groups.map(([group, entries]) => (
            <div key={group}>
              <div className="flex items-center justify-between px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>{group}</span>
                <span className="tnum">{entries.filter((e) => done.has(e.item.id)).length}/{entries.length}</span>
              </div>
              {entries.map(({ item, index }) => (
                <button
                  key={item.id}
                  onClick={() => setItemIndex(index)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    index === itemIndex ? "bg-accent text-foreground" : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-foreground",
                  )}
                  aria-current={index === itemIndex}
                >
                  {done.has(item.id) ? (
                    <DoneIcon className="h-3.5 w-3.5 shrink-0 text-state-pass" aria-label="Annotated" />
                  ) : (
                    <TodoIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-label="Not annotated" />
                  )}
                  <span className="truncate">{item.name}</span>
                </button>
              ))}
            </div>
          ))}
          {!groups.length && <p className="px-2 py-6 text-center text-sm text-muted-foreground">No files match “{query}”.</p>}
        </div>
      </ScrollArea>
    </div>
  );
}
