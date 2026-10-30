import { useMemo, useState } from "react";
import { AiIcon, DoneIcon, ImportedIcon, SearchIcon, TodoIcon } from "@studio/ui/icons";
import { Input } from "@studio/ui/ui/input";
import { ScrollArea } from "@studio/ui/ui/scroll-area";
import { cn } from "@studio/ui/utils";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { useStudio } from "@/studio/stores/studio";
import { itemKind, KINDS } from "@/studio/lib/file-kinds";
import type { Annotation, StudioItem } from "@studio/contracts/types";

/**
 * Per item: a person annotated it; it only has labels imported from the user's own files
 * (todo6 D8) or AI suggestions, neither confirmed yet; or nothing. AI never reads as human work.
 */
export type ItemState = "annotated" | "imported" | "suggested" | "todo";

const RANK: Record<ItemState, number> = { todo: 0, suggested: 1, imported: 2, annotated: 3 };

export function itemStates(annotations: Annotation[]): Map<string, ItemState> {
  const out = new Map<string, ItemState>();
  for (const a of annotations) {
    const state: ItemState = a.provenance === "imported" ? "imported" : a.provenance === "ai-suggested" ? "suggested" : "annotated";
    if (RANK[state] > RANK[out.get(a.itemId) ?? "todo"]) out.set(a.itemId, state);
  }
  return out;
}

const STATE = {
  annotated: { icon: DoneIcon, label: "Annotated", className: "text-state-pass" },
  imported: { icon: ImportedIcon, label: "Imported labels, not reviewed", className: "text-info" },
  suggested: { icon: AiIcon, label: "AI suggestions, not reviewed", className: "text-ai-text" },
  todo: { icon: TodoIcon, label: "Not annotated", className: "text-muted-foreground/50" },
} as const;

/**
 * `inkling.core.panels.files`: the task's items (never the project's source tree, docs/ux.md
 * §8) by group, so volume and series kinds list studies or series rather than slices. Each
 * row shows its data kind and whether it's annotated or only has imported labels.
 */
export function FilesPanel({ items, env }: PanelProps) {
  const [query, setQuery] = useState("");
  const itemIndex = useStudio((s) => s.itemIndex);
  const setItemIndex = useStudio((s) => s.setItemIndex);
  const annotations = useStudio((s) => s.annotations);
  const states = useMemo(() => itemStates(annotations), [annotations]);
  const KindFallback = env.dataKind.icon;

  const groups = useMemo(() => {
    const out = new Map<string, { item: StudioItem; index: number }[]>();
    items.forEach((item, index) => {
      if (query && !item.name.toLowerCase().includes(query.toLowerCase())) return;
      out.set(item.group, [...(out.get(item.group) ?? []), { item, index }]);
    });
    return [...out.entries()];
  }, [items, query]);

  return (
    <div className="flex h-full flex-col" data-testid="files-panel">
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
                <span className="tnum" title="Annotated">{entries.filter((e) => states.get(e.item.id) === "annotated").length}/{entries.length}</span>
              </div>
              {entries.map(({ item, index }) => {
                const state = STATE[states.get(item.id) ?? "todo"];
                const kind = itemKind(item);
                const KindIcon = kind ? KINDS[kind].icon : KindFallback;
                const kindLabel = kind ? KINDS[kind].label : env.dataKind.label;
                return (
                  <button
                    key={item.id}
                    onClick={() => setItemIndex(index)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      index === itemIndex ? "bg-accent text-foreground" : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-foreground",
                    )}
                    aria-current={index === itemIndex}
                    data-testid="file-row"
                    data-state={states.get(item.id) ?? "todo"}
                  >
                    <state.icon className={cn("h-3.5 w-3.5 shrink-0", state.className)} aria-label={state.label} />
                    <KindIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={kindLabel} data-testid="file-kind" />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {!groups.length && <p className="px-2 py-6 text-center text-sm text-muted-foreground">No files match “{query}”.</p>}
        </div>
      </ScrollArea>
    </div>
  );
}
