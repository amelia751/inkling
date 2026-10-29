import { useMemo, useState } from "react";
import { CheckCircle2, Circle, Search, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { labelColor } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { LOCAL_AUTHOR, useStudio } from "@/stores/studio";
import type { Annotation, Project, Provenance, StudioItem } from "@/types";

export function LeftSidebar({ project, items }: { project: Project; items: StudioItem[] }) {
  return (
    <Tabs defaultValue="files" className="flex h-full flex-col bg-[var(--bg-primary)]">
      <div className="border-b border-[var(--border-color)] px-2 py-2">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="labels">Labels</TabsTrigger>
          <TabsTrigger value="review">Review</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="files" className="mt-0 min-h-0 flex-1">
        <FilesTab items={items} />
      </TabsContent>
      <TabsContent value="labels" className="mt-0 min-h-0 flex-1">
        <LabelsTab project={project} items={items} />
      </TabsContent>
      <TabsContent value="review" className="mt-0 min-h-0 flex-1">
        <ReviewTab project={project} items={items} />
      </TabsContent>
    </Tabs>
  );
}

function FilesTab({ items }: { items: StudioItem[] }) {
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
        <Search className="absolute left-4 top-1/2 mt-1 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
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
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-state-pass" aria-label="Annotated" />
                  ) : (
                    <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-label="Not annotated" />
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

function LabelsTab({ project, items }: { project: Project; items: StudioItem[] }) {
  const labels = project.labels ?? [];
  const activeLabel = useStudio((s) => s.activeLabel);
  const setActiveLabel = useStudio((s) => s.setActiveLabel);
  const annotations = useStudio((s) => s.annotations);
  const itemIndex = useStudio((s) => s.itemIndex);
  const setClass = useStudio((s) => s.setClass);
  const item = items[itemIndex];
  const classification = project.task === "classification";
  const current = annotations.find((a) => a.itemId === item?.id && a.geometry.type === "class");

  return (
    <ScrollArea className="h-full [&>[data-radix-scroll-area-viewport]>div]:!block">
      <div className="space-y-4 p-3">
        {classification && item && (
          <section>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">Image label for {item.name}</h3>
            <p className="mb-2 text-xs text-muted-foreground">Pick the class that best describes this whole image.</p>
            <div className="grid grid-cols-2 gap-1.5">
              {labels.map((l) => (
                <button
                  key={l}
                  onClick={() => setClass(item.id, l, LOCAL_AUTHOR)}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-sm capitalize transition-colors",
                    current?.label === l ? "border-primary bg-primary text-primary-foreground" : "border-[var(--border-color)] hover:bg-[var(--bg-tertiary)]",
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
          </section>
        )}
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">{classification ? "Region labels" : "Label classes"}</h3>
          <div className="space-y-0.5">
            {labels.map((l, i) => {
              const count = annotations.filter((a) => a.label === l && a.geometry.type !== "class").length;
              return (
                <button
                  key={l}
                  onClick={() => setActiveLabel(l)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                    activeLabel === l ? "bg-accent" : "hover:bg-[var(--bg-tertiary)]",
                  )}
                  aria-pressed={activeLabel === l}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: labelColor(labels, l) }} />
                  <span className="flex-1 truncate text-left capitalize">{l}</span>
                  <kbd className="rounded border border-[var(--border-color)] px-1 font-mono text-[10px] text-muted-foreground">{i + 1}</kbd>
                  <span className="tnum w-5 text-right text-xs text-muted-foreground">{count}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </ScrollArea>
  );
}

const PROVENANCE: Record<Provenance, { label: string; className: string }> = {
  "human-created": { label: "Human created", className: "border-prov-human/40 text-prov-human" },
  "ai-suggested": { label: "AI suggested", className: "border-prov-ai bg-prov-ai text-prov-ai-foreground" },
  "human-corrected": { label: "Human corrected", className: "border-prov-corrected/40 text-prov-corrected" },
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const p = PROVENANCE[provenance];
  return (
    <Badge variant="outline" className={cn("h-5 px-1.5 text-[10px] font-medium", p.className)}>
      {p.label}
    </Badge>
  );
}

export function describeGeometry(a: Annotation): string {
  const g = a.geometry;
  switch (g.type) {
    case "class":
      return "Image label";
    case "box":
      return `Box ${Math.round(g.w)}×${Math.round(g.h)}px${g.frame !== undefined ? ` · frame ${g.frame + 1}` : ""}`;
    case "point":
      return `Point · ${g.plane} ${g.slice + 1}`;
    case "interval":
      return `${g.lead} · ${g.start.toFixed(2)}–${g.end.toFixed(2)}s`;
    case "polygon":
      return `Contour · ${g.points.length} pts${g.frame !== undefined ? ` · frame ${g.frame + 1}` : ""}${g.slice !== undefined ? ` · slice ${g.slice + 1}` : ""}`;
    case "mark":
      return `Mark · ${Math.round(g.x)}, ${Math.round(g.y)}`;
    case "segment":
      return `Span ${g.start.toFixed(2)}–${g.end.toFixed(2)}s`;
  }
}

function ReviewTab({ project, items }: { project: Project; items: StudioItem[] }) {
  const [filter, setFilter] = useState<"all" | "unlabeled">("all");
  const annotations = useStudio((s) => s.annotations);
  const setItemIndex = useStudio((s) => s.setItemIndex);
  const remove = useStudio((s) => s.remove);
  const labels = project.labels ?? [];
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
                <button className="w-full text-left" onClick={() => setItemIndex(indexOf(a.itemId))}>
                  <div className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: labelColor(labels, a.label) }} />
                    <span className="truncate font-medium capitalize">{a.label}</span>
                    <span className="ml-auto"><ProvenanceBadge provenance={a.provenance} /></span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {items[indexOf(a.itemId)]?.name} · {describeGeometry(a)}
                  </div>
                </button>
                <button
                  onClick={() => remove(a.id)}
                  className="mt-1 hidden items-center gap-1 text-xs text-muted-foreground hover:text-state-fail group-hover:flex"
                >
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              </div>
            ))}
          {filter === "all" && !annotations.length && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No annotations yet. Pick a label and draw on the canvas.</p>
          )}
          {filter === "unlabeled" &&
            unlabeled.map((i) => (
              <button key={i.id} onClick={() => setItemIndex(indexOf(i.id))} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)]">
                <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />
                <span className="truncate">{i.name}</span>
              </button>
            ))}
        </div>
      </ScrollArea>
    </div>
  );
}
