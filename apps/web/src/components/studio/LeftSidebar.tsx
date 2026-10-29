import { useMemo, useState } from "react";
import { DoneIcon, TodoIcon, ShowIcon, HideIcon, LockIcon, SearchIcon, DeleteIcon, UnlockIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { labelColor } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { isEditable, LOCAL_AUTHOR, useStudio } from "@/stores/studio";
import type { Annotation, Project, Provenance, StudioItem } from "@/types";
import { adapterFor } from "@/viewers/registry";

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
  const hiddenLabels = useStudio((s) => s.hiddenLabels);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const toggleHidden = useStudio((s) => s.toggleLabelHidden);
  const toggleLocked = useStudio((s) => s.toggleLabelLocked);
  const opacity = useStudio((s) => s.overlayOpacity);
  const setOpacity = useStudio((s) => s.setOverlayOpacity);
  const selectedId = useStudio((s) => s.selectedId);
  const selectedIds = useStudio((s) => s.selectedIds);
  const selected = annotations.find((a) => a.id === selectedId);
  const multi = annotations.filter((a) => selectedIds.includes(a.id));

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
              const hidden = hiddenLabels.includes(l);
              const locked = lockedLabels.includes(l);
              return (
                <div
                  key={l}
                  className={cn("group flex items-center gap-1 rounded-md pr-1 transition-colors", activeLabel === l ? "bg-accent" : "hover:bg-[var(--bg-tertiary)]")}
                >
                  <button onClick={() => setActiveLabel(l)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm" aria-pressed={activeLabel === l}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: labelColor(labels, l), opacity: hidden ? 0.35 : 1 }} />
                    <span className={cn("flex-1 truncate text-left capitalize", hidden && "text-muted-foreground line-through")}>{l}</span>
                    <kbd className="rounded border border-[var(--border-color)] px-1 font-mono text-[10px] text-muted-foreground">{i + 1}</kbd>
                    <span className="tnum w-5 text-right text-xs text-muted-foreground">{count}</span>
                  </button>
                  <button
                    onClick={() => toggleHidden(l)}
                    className={cn("rounded p-1 text-muted-foreground hover:text-foreground", !hidden && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                    aria-label={hidden ? `Show ${l}` : `Hide ${l}`}
                    aria-pressed={hidden}
                  >
                    {hidden ? <HideIcon className="h-3.5 w-3.5" /> : <ShowIcon className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    onClick={() => toggleLocked(l)}
                    className={cn("rounded p-1 text-muted-foreground hover:text-foreground", !locked && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                    aria-label={locked ? `Unlock ${l}` : `Lock ${l}`}
                    aria-pressed={locked}
                  >
                    {locked ? <LockIcon className="h-3.5 w-3.5" /> : <UnlockIcon className="h-3.5 w-3.5" />}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-2 px-2 text-xs text-muted-foreground">
            <span className="shrink-0">Overlay opacity</span>
            <Slider value={[opacity]} min={0} max={1} step={0.05} onValueChange={([v]) => setOpacity(v)} aria-label="Overlay opacity" />
            <span className="tnum w-8 text-right">{Math.round(opacity * 100)}%</span>
          </div>
        </section>
        {multi.length > 1 ? (
          <MultiSelectionPanel project={project} annotations={multi} />
        ) : (
          selected && item && <SelectionInspector project={project} item={item} annotation={selected} />
        )}
      </div>
    </ScrollArea>
  );
}

/** Several annotations selected: per-label counts and bulk relabel, lock, hide, delete (one undo step each). */
function MultiSelectionPanel({ project, annotations }: { project: Project; annotations: Annotation[] }) {
  const labels = project.labels ?? [];
  const batch = useStudio((s) => s.batch);
  const select = useStudio((s) => s.select);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const editable = annotations.filter((a) => isEditable(a, lockedLabels));
  const counts = new Map<string, number>();
  for (const a of annotations) counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
  const allLocked = annotations.every((a) => a.locked);
  const allHidden = annotations.every((a) => a.hidden);
  const patchAll = (list: Annotation[], patch: Partial<Annotation>) => batch({ update: list.map((a) => ({ id: a.id, patch })) });

  return (
    <section className="rounded-md border border-[var(--border-color)] p-2.5" aria-label="Selected annotations">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{annotations.length} selected</h3>
        <button onClick={() => select(null)} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Clear</button>
      </div>
      <ul className="mb-2 space-y-0.5 text-xs">
        {[...counts].map(([l, n]) => (
          <li key={l} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: labelColor(labels, l) }} />
            <span className="flex-1 truncate capitalize">{l}</span>
            <span className="tnum text-muted-foreground">{n}</span>
          </li>
        ))}
      </ul>
      <label className="mb-2 flex items-center gap-2 text-xs">
        <span className="w-12 text-muted-foreground">Relabel</span>
        <select
          value=""
          disabled={!editable.length}
          onChange={(e) => e.target.value && patchAll(editable, { label: e.target.value })}
          className="h-7 flex-1 rounded-md border border-[var(--border-color)] bg-transparent px-1.5 text-sm capitalize"
        >
          <option value="">Choose a label…</option>
          {labels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-1">
        <button onClick={() => patchAll(annotations, { locked: !allLocked })} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-foreground">
          {allLocked ? <UnlockIcon className="h-3 w-3" /> : <LockIcon className="h-3 w-3" />} {allLocked ? "Unlock" : "Lock"} all
        </button>
        <button onClick={() => patchAll(annotations, { hidden: !allHidden })} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-foreground">
          {allHidden ? <ShowIcon className="h-3 w-3" /> : <HideIcon className="h-3 w-3" />} {allHidden ? "Show" : "Hide"} all
        </button>
        <button
          onClick={() => batch({ remove: editable.map((a) => a.id) })}
          disabled={!editable.length}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-state-fail disabled:opacity-40"
        >
          <DeleteIcon className="h-3 w-3" /> Delete {editable.length < annotations.length ? `${editable.length} unlocked` : "all"}
        </button>
      </div>
    </section>
  );
}

/** Selected annotation: label, physical measurements from the viewer, lock/hide, delete. */
function SelectionInspector({ project, item, annotation: a }: { project: Project; item: StudioItem; annotation: Annotation }) {
  const labels = project.labels ?? [];
  const update = useStudio((s) => s.update);
  const remove = useStudio((s) => s.remove);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const editable = isEditable(a, lockedLabels);
  const rows = adapterFor(project)?.inspect?.(a, { project, item }) ?? [];

  return (
    <section className="rounded-md border border-[var(--border-color)] p-2.5" aria-label="Selected annotation">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Selected</h3>
        <span className="ml-auto"><ProvenanceBadge provenance={a.provenance} /></span>
      </div>
      <div className="mb-2 text-xs text-muted-foreground">{describeGeometry(a)}</div>
      <label className="mb-2 flex items-center gap-2 text-xs">
        <span className="w-12 text-muted-foreground">Label</span>
        <select
          value={a.label}
          // Rhythm episodes and record statements carry their own vocabulary as the label.
          disabled={!editable || a.geometry.type === "rhythm" || (a.geometry.type === "class" && !labels.includes(a.label))}
          onChange={(e) => update(a.id, { label: e.target.value })}
          className="h-7 flex-1 rounded-md border border-[var(--border-color)] bg-transparent px-1.5 text-sm capitalize"
        >
          {!labels.includes(a.label) && <option value={a.label}>{a.label}</option>}
          {labels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </label>
      {rows.length > 0 && (
        <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="tnum text-right">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex items-center gap-1">
        <button onClick={() => update(a.id, { locked: !a.locked })} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-foreground">
          {a.locked ? <UnlockIcon className="h-3 w-3" /> : <LockIcon className="h-3 w-3" />} {a.locked ? "Unlock" : "Lock"}
        </button>
        <button onClick={() => update(a.id, { hidden: !a.hidden })} className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-foreground">
          {a.hidden ? <ShowIcon className="h-3 w-3" /> : <HideIcon className="h-3 w-3" />} {a.hidden ? "Show" : "Hide"}
        </button>
        <button
          onClick={() => remove(a.id)}
          disabled={!editable}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-[var(--bg-tertiary)] hover:text-state-fail disabled:opacity-40"
        >
          <DeleteIcon className="h-3 w-3" /> Delete
        </button>
      </div>
    </section>
  );
}

const PROVENANCE: Record<Provenance, { label: string; theme: "clear" | "ai" | "info" }> = {
  "human-created": { label: "Human created", theme: "clear" },
  "ai-suggested": { label: "AI suggested", theme: "ai" },
  "human-corrected": { label: "Human corrected", theme: "info" },
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  const p = PROVENANCE[provenance];
  return <Badge theme={p.theme}>{p.label}</Badge>;
}

const fmt = (n: number, d = 2) => n.toFixed(d);
const at = (g: { frame?: number; slice?: number; plane?: string }) =>
  `${g.plane ? ` · ${g.plane}` : ""}${g.slice !== undefined ? ` · slice ${g.slice + 1}` : ""}${g.frame !== undefined ? ` · frame ${g.frame + 1}` : ""}`;

export function describeGeometry(a: Annotation): string {
  const g = a.geometry;
  switch (g.type) {
    case "class":
      return "Image label";
    case "box":
      return `Box ${Math.round(g.w)}×${Math.round(g.h)}px${at(g)}`;
    case "ellipse":
      return `Ellipse ${Math.round(g.rx * 2)}×${Math.round(g.ry * 2)}px${at(g)}`;
    case "polygon":
      return `Polygon · ${g.points.length} pts${g.holes?.length ? ` · ${g.holes.length} holes` : ""}${at(g)}`;
    case "multipolygon":
      return `Region · ${g.polygons.length} parts${at(g)}`;
    case "polyline":
      return `Polyline · ${g.points.length} pts${at(g)}`;
    case "spline":
      return `Spline contour · ${g.points.length} control pts${at(g)}`;
    case "keypoint":
      return `Keypoint · ${Math.round(g.x)}, ${Math.round(g.y)}${at(g)}`;
    case "mark":
      return `Point · ${Math.round(g.x)}, ${Math.round(g.y)}`;
    case "point":
      return `Point · ${g.plane} ${g.slice + 1}`;
    case "measurement": {
      const main = g.stats && Object.entries(g.stats)[0];
      return `${g.kind.replace(/-/g, " ")}${main ? ` · ${fmt(main[1])}${g.unit ? ` ${g.unit}` : ""}` : ""}${at(g)}`;
    }
    case "mask":
      return `Mask${g.volumeMm3 !== undefined ? ` · ${fmt(g.volumeMm3 / 1000)} mL` : g.voxels !== undefined ? ` · ${g.voxels.toLocaleString()} px` : ""}${at(g)}`;
    case "interval":
      return `${g.lead === "all" ? "All leads" : g.lead} · ${fmt(g.start)}–${fmt(g.end)}s`;
    case "beat":
      return `Beat ${g.code} · ${fmt(g.t, 3)}s${g.lead === "all" ? "" : ` · ${g.lead}`}`;
    case "wave":
      return `${g.wave} wave · ${g.lead} · ${fmt(g.onset, 3)}–${fmt(g.offset, 3)}s`;
    case "rhythm":
      return `Rhythm ${g.rhythm} · ${fmt(g.start)}–${fmt(g.end)}s`;
    case "segment":
      return `Span ${fmt(g.start)}–${fmt(g.end)}s`;
    case "event":
      return `Event · frame ${g.frame + 1}`;
    case "phase":
      return `${g.phase === "ED" ? "End-diastole" : "End-systole"} · frame ${g.frame + 1}`;
    case "track": {
      const frames = g.keyframes.map((k) => k.frame);
      return `Track (${g.shape}) · ${g.keyframes.length} keyframes · frames ${Math.min(...frames) + 1}–${Math.max(...frames) + 1}`;
    }
  }
}

function ReviewTab({ project, items }: { project: Project; items: StudioItem[] }) {
  const [filter, setFilter] = useState<"all" | "unlabeled">("all");
  const annotations = useStudio((s) => s.annotations);
  const setItemIndex = useStudio((s) => s.setItemIndex);
  const remove = useStudio((s) => s.remove);
  const select = useStudio((s) => s.select);
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
                    {items[indexOf(a.itemId)]?.name} · {describeGeometry(a)}
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
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No annotations yet. Pick a label and draw on the canvas.</p>
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
