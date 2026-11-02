import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { InTrashBadge } from "@/studio/components/trash/delete-dialog";
import { isTrashedItem } from "@/studio/lib/trash-api";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AddDataIcon, AiIcon, ArrowDownIcon, CloseIcon, DoneIcon, FileIcon, FolderIcon, FolderOpenIcon, MaskFileIcon, FoldersIcon, ImportedIcon, QueueIcon, SearchIcon, TodoIcon, type IconComponent } from "@studio/ui/icons";
import { Input } from "@studio/ui/ui/input";
import { FileTree, type FileTreeHandle, type FileTreeNode } from "@studio/ui/ui/file-tree";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { cn } from "@studio/ui/utils";
import type { PanelProps } from "@studio/plugin-ui-sdk/module";
import { useCommands } from "@/extension-host/commands";
import { markAfterPaint } from "@/extension-host/boot-timing";
import { useStudio } from "@/studio/stores/studio";
import { readView, useItemsView, type ItemsView } from "@/studio/stores/items-view";
import { itemKind, KINDS } from "@/studio/lib/file-kinds";
import { itemNoun, plural, pluralWord } from "@/studio/lib/format";
import { filesUrl } from "@/studio/lib/routes";
import { onProjectEvent } from "@/studio/lib/use-project-events";
import { dirsAbove, disambiguate, folderCount, inFolder, inQueue, itemTree, mixesKinds, QUEUE_FILTERS, showFilePaths, showSourceLabels, type ItemDir, type ItemState, type QueueFilter } from "@/studio/lib/item-folders";
import { kindFolder, queueCountsByKind } from "@/studio/lib/per-kind";
import { bundleCount, HOVER_DELAY_MS, ItemHoverCard } from "./item-hover-card";
import { ItemThumb } from "./item-thumb";
import { DropOverlay, usePickers } from "@/studio/components/uploads/uploads";
import { useUploads } from "@/studio/stores/uploads";
import { kernelEnabled } from "@/extension-host/kernel";
import { insertRegistered, postVisible } from "@/studio/lib/task-items";
import type { Picked } from "@/studio/lib/uploads/walk";
import type { Annotation, StudioItem } from "@studio/contracts/types";
import { CORE } from "../manifest";

export type { ItemState } from "@/studio/lib/item-folders";

/**
 * Per item: a person annotated it; it only has labels imported from the user's own files
 * (todo6 D8) or AI suggestions, neither confirmed yet; or nothing. AI never reads as human work.
 */
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

/** The tree draws a row's icon in its own color; a state icon keeps the state's (`!` wins). */
const STATE_TREE_ICON = Object.fromEntries(
  (Object.keys(STATE) as ItemState[]).map((k) => {
    const { icon: Icon, className, label } = STATE[k];
    const Tinted: IconComponent = ((p: { className?: string }) => <Icon {...p} aria-label={label} className={cn(p.className, className.replace(/(^| )/g, "$1!"))} />) as unknown as IconComponent;
    return [k, Tinted];
  }),
) as Record<ItemState, IconComponent>;

const ITEM = "item:";
/** A part row under an item (`part:<index>:<key>`): a subject's sequence, a study's series. */
const PART = "part:";
const partId = (index: number, key: string) => `${PART}${index}:${key}`;
const parsePart = (id: string) => {
  const rest = id.slice(PART.length);
  const at = rest.indexOf(":");
  return { index: Number(rest.slice(0, at)), key: rest.slice(at + 1) };
};

/**
 * `studio.core.panels.files`, the Items panel (todo8 D3): the task's items (never raw slices
 * nor the project's whole drive, docs/ux.md §8) in two views. **Folders** follows Data (same
 * tree, compaction and numbered runs, folder progress) and is the default when the items span
 * more than one folder; **Queue** is the flat work order with status chips. The view is
 * remembered per task in this browser. Duplicate names get their shortest distinguishing
 * folder, dimmed; a hover card tells the rest; the row menu has Show in Sources. A blind task
 * (D8) never shows the labels that came with the files.
 */
export function FilesPanel({ items, env, project }: PanelProps) {
  const taskId = project.id;
  const routeProject = useParams().projectId;
  const projectId = routeProject ?? (project as { projectId?: string }).projectId ?? project.id;
  const navigate = useNavigate();
  const itemIndex = useStudio((s) => s.itemIndex);
  const setItemIndex = useStudio((s) => s.setItemIndex);
  const annotations = useStudio((s) => s.annotations);
  const states = useMemo(() => itemStates(annotations), [annotations]);
  const stateOf = useCallback((i: StudioItem): ItemState => states.get(i.id) ?? "todo", [states]);
  const showLabel = showSourceLabels(env);
  const showPath = showFilePaths(env);
  const blind = !showLabel;
  // Boot timeline (todo11 Milestone 1): the items rail has rows on screen.
  const hasItems = items.length > 0;
  useEffect(() => {
    if (hasItems) markAfterPaint("items-painted");
  }, [hasItems]);

  // Items without a Data folder (the seed stand-in without the API) fall back to `group` as
  // their heading, but never to the source label (D8).
  const viewItems = useMemo(
    () => items.map((i) => (i.folder ? i : { ...i, folder: i.group && i.group.toLowerCase() !== i.sourceLabel?.toLowerCase() ? [i.group] : [] })),
    [items],
  );
  const suffixes = useMemo(() => disambiguate(viewItems), [viewItems]);
  // todo11 D8: items dropped here ingest in place; their rows get thumbnails (skeletons first).
  const thumbs = useMemo(() => items.some((i) => i.assets[0]?.ingest), [items]);
  const mixed = useMemo(() => mixesKinds(items.map((i) => itemKind(i) ?? i.dataKind)), [items]);

  const chosen = useItemsView((s) => s.views[taskId]);
  const setView = useItemsView((s) => s.setView);
  const [stored] = useState(() => readView(taskId));
  const view: ItemsView = chosen ?? stored ?? (folderCount(viewItems) > 1 || viewItems.some((i) => (i.parts?.length ?? 0) > 1) ? "folders" : "queue");
  const queueFilter = useItemsView((s) => s.queueFilter);
  const setQueueFilter = useItemsView((s) => s.setQueueFilter);
  const folderFilter = useItemsView((s) => s.folderFilter);
  const setFolderFilter = useItemsView((s) => s.setFolderFilter);

  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const openFilter = () => {
    setFilterOpen(true);
    requestAnimationFrame(() => filterInput.current?.focus());
  };
  // ⌘F inside the panel (the key comes from the core command, never from here).
  const panelKeys = useCommands({ filterItems: () => openFilter() }, { scope: CORE, enabled: focused });

  // A rename or move in Sources changes folders and names: refetch the task document (todo7 fs.changed).
  const qc = useQueryClient();
  useEffect(
    () =>
      onProjectEvent("fs.changed", (data) => {
        const touched = new Set(((data as { nodeIds?: string[] } | null)?.nodeIds ?? []) as string[]);
        if (!touched.size || items.some((i) => i.assets.some((a) => a.nodeId && touched.has(a.nodeId)))) void qc.invalidateQueries({ queryKey: ["tasks", taskId, "document"] });
      }),
    [items, qc, taskId],
  );

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return viewItems.flatMap((it, index) => {
      if (q && !it.name.toLowerCase().includes(q) && !(it.folder ?? []).some((s) => s.toLowerCase().includes(q))) return [];
      if (folderFilter && !inFolder(it.folder, folderFilter)) return [];
      return [index];
    });
  }, [viewItems, query, folderFilter]);

  // ---- Hover card (400ms) and row menu -------------------------------------------------------
  const [hover, setHover] = useState<{ index: number; left: number; top: number } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const enter = (index: number, el: HTMLElement) => {
    window.clearTimeout(hoverTimer.current);
    const r = el.getBoundingClientRect();
    hoverTimer.current = window.setTimeout(() => setHover({ index, left: Math.min(r.right + 8, window.innerWidth - 296), top: Math.max(8, Math.min(r.top, window.innerHeight - 280)) }), HOVER_DELAY_MS);
  };
  const leave = () => {
    window.clearTimeout(hoverTimer.current);
    setHover(null);
  };
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const openMenu = (index: number, e: { clientX: number; clientY: number; preventDefault: () => void }) => {
    e.preventDefault();
    leave();
    setMenu({ x: e.clientX, y: e.clientY, index });
  };

  const choose = (index: number) => {
    leave();
    // Re-clicking the open item keeps the selection (setItemIndex clears it).
    if (index !== useStudio.getState().itemIndex) setItemIndex(index);
  };

  const noun = itemNoun(env);
  // Drop files on the rail (or Add): an import into this task, its images are items at once.
  const qcForDrop = useQueryClient();
  const canDrop = kernelEnabled() && !!(project as { projectId?: string }).projectId;
  const drop = (picked: Picked) => {
    if (!canDrop) return;
    void useUploads.getState().add(projectId, picked, { taskId, onRegistered: (assets) => insertRegistered(qcForDrop, taskId, assets) });
  };
  const pickers = usePickers(drop);
  const header = (
    <div className="flex h-9 shrink-0 items-center gap-1 pl-3 pr-1.5" data-testid="items-header">
      <span className="min-w-0 flex-1 truncate text-sm font-medium" data-testid="items-title">
        {plural(items.length, noun)}
      </span>
      {canDrop && (
        <>
          {pickers.inputs}
          <IconToggle label={`Add ${pluralWord(2, noun)}`} pressed={false} onClick={pickers.files} testid="items-add" icon={AddDataIcon} />
        </>
      )}
      <IconToggle label="Filter" pressed={filterOpen} onClick={() => (filterOpen ? (setFilterOpen(false), setQuery("")) : openFilter())} testid="items-filter-toggle" icon={SearchIcon} />
      <div className="ml-1 flex items-center rounded-md bg-generic p-0.5" role="group" aria-label="View">
        <IconToggle label="Folders" pressed={view === "folders"} onClick={() => setView(taskId, "folders")} testid="items-view-folders" icon={FoldersIcon} />
        <IconToggle label="Queue" pressed={view === "queue"} onClick={() => setView(taskId, "queue")} testid="items-view-queue" icon={QueueIcon} />
      </div>
    </div>
  );

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of QUEUE_FILTERS) out[f.id] = matching.filter((i) => inQueue(stateOf(items[i]), f.id)).length;
    return out;
  }, [matching, items, stateOf]);
  // todo19 D8: the same counts per kind (item counts only; throughput units never add up across kinds).
  const byKind = useMemo(
    () => (mixed ? queueCountsByKind(matching.map((i) => items[i]), (k) => stateOf(items[matching[k]]), env.dataKind.id).byKind : {}),
    [mixed, matching, items, stateOf, env.dataKind.id],
  );
  const kindTitle = (f: QueueFilter) => Object.entries(byKind).map(([k, c]) => `${kindFolder(k)} ${c[f]}`).join(" · ") || undefined;
  const queued = matching.filter((i) => inQueue(stateOf(items[i]), queueFilter));

  const hovered = hover ? items[hover.index] : undefined;
  const panel = (
    <div
      className="flex h-full flex-col"
      data-testid="files-panel"
      data-view={view}
      onFocus={() => setFocused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setFocused(false)}
    >
      {header}
      {filterOpen && (
        <div className="relative px-2 pb-1.5">
          <SearchIcon className="absolute left-4 top-1/2 -mt-0.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={filterInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                setFilterOpen(false);
              }
            }}
            placeholder={`Filter ${pluralWord(2, noun)}`}
            className="h-7 pl-7 text-sm"
            data-testid="items-filter"
          />
        </div>
      )}
      {folderFilter && (
        <div className="mx-2 mb-1.5 flex items-center gap-1 rounded-md bg-generic px-2 py-1 text-xs" data-testid="items-folder-filter">
          <FolderIcon className="size-3.5 shrink-0 text-hint" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{folderFilter.join(" / ") || "All folders"}</span>
          <button className="rounded p-0.5 hover:bg-[var(--bg-tertiary)]" onClick={() => setFolderFilter(null)} aria-label="Show every folder">
            <CloseIcon className="size-3" />
          </button>
        </div>
      )}
      {view === "queue" ? (
        <>
          <div className="flex flex-wrap gap-1 px-2 pb-1.5" role="group" aria-label="Status">
            {QUEUE_FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setQueueFilter(f.id)}
                aria-pressed={queueFilter === f.id}
                className={cn(
                  "flex h-6 items-center gap-1 rounded-full px-2 text-xs transition-colors",
                  queueFilter === f.id ? "bg-selection text-foreground" : "text-muted-foreground hover:bg-generic hover:text-foreground",
                )}
                data-testid="queue-chip"
                data-filter={f.id}
                title={kindTitle(f.id)}
              >
                {f.label}
                <span className="tnum text-hint">{counts[f.id]}</span>
              </button>
            ))}
          </div>
          <QueueList
            taskId={taskId}
            items={items}
            queued={queued}
            render={(index) => (
              <QueueRow
                item={items[index]}
                index={index}
                current={index === itemIndex}
                state={stateOf(items[index])}
                suffix={suffixes[index]}
                kindIcon={mixed ? kindIconOf(items[index], env.dataKind.icon) : undefined}
                thumb={thumbs ? <ItemThumb itemId={items[index].id} asset={items[index].assets[0]} /> : undefined}
                onChoose={choose}
                onEnter={enter}
                onLeave={leave}
                onMenu={openMenu}
              />
            )}
            empty={<Empty query={query} filter={queueFilter} total={items.length} noun={noun} />}
          />
        </>
      ) : (
        <FoldersView
          items={viewItems}
          indices={matching}
          states={states}
          itemIndex={itemIndex}
          suffixes={suffixes}
          mixed={mixed}
          fallbackIcon={env.dataKind.icon}
          filtering={!!query.trim() || !!folderFilter}
          onChoose={choose}
          onEnter={enter}
          onLeave={leave}
          onMenu={openMenu}
          onKey={(e) => panelKeys(e.nativeEvent)}
          empty={<Empty query={query} filter="all" total={items.length} noun={noun} />}
        />
      )}
      {hovered && hover && (
        <ItemHoverCard item={hovered} state={stateOf(hovered)} annotations={annotations} env={env} at={hover} showLabel={showLabel} showPath={showPath} blind={blind} />
      )}
      {menu && (
        <DropdownMenu open onOpenChange={(o) => !o && setMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span aria-hidden className="fixed size-0" style={{ left: menu.x, top: menu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48" data-testid="item-context-menu">
            <DropdownMenuItem
              disabled={!items[menu.index]?.nodeId}
              onSelect={() => {
                const nodeId = items[menu.index]?.nodeId;
                if (nodeId) navigate(filesUrl(projectId, nodeId));
              }}
              data-testid="show-in-data"
            >
              <FolderOpenIcon aria-hidden /> Show in Sources
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
  return canDrop ? (
    <DropOverlay onDrop={drop} label={project.title} className="h-full">
      {panel}
    </DropOverlay>
  ) : (
    panel
  );
}

const ROW = 28;

/**
 * The Queue view's rows, virtualized (TanStack Virtual, keyed by item id): a 10k-item task
 * renders a screenful. While items stream in and the end isn't on screen, a pill counts the
 * new ones and jumps there. The ingesting items on screen are posted to the kernel, so the
 * worker makes their thumbnails first.
 */
function QueueList({ taskId, items, queued, render, empty }: { taskId: string; items: StudioItem[]; queued: number[]; render: (index: number) => ReactNode; empty: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: queued.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 10, getItemKey: (i) => items[queued[i]]?.id ?? i, paddingEnd: 8 });
  const rows = v.getVirtualItems();
  const lastShown = rows.at(-1)?.index ?? -1;
  const atEnd = lastShown >= queued.length - 1;
  // "N new": items that arrived while the end wasn't on screen.
  const [seen, setSeen] = useState(queued.length);
  useEffect(() => {
    if (atEnd) setSeen(queued.length);
  }, [atEnd, queued.length]);
  const fresh = Math.max(0, queued.length - seen);
  // Visible ingesting items first (a hint; the kernel keeps the latest).
  const first = rows[0]?.index ?? 0;
  const visibleIds = useMemo(() => queued.slice(first, lastShown + 1).map((i) => items[i]).filter((it) => it?.assets[0]?.ingest && it.assets[0].ingest.state !== "ready" && it.assets[0].ingest.state !== "failed").map((it) => it.id), [queued, first, lastShown, items]);
  useEffect(() => postVisible(taskId, visibleIds), [taskId, visibleIds]);
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} className="h-full overflow-y-auto px-1.5" role="list" data-testid="items-queue">
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {rows.map((r) => (
            <div key={r.key} className="absolute inset-x-0" style={{ top: r.start, height: ROW }} data-index={r.index}>
              {render(queued[r.index])}
            </div>
          ))}
        </div>
        {!queued.length && empty}
      </div>
      {fresh > 0 && !atEnd && (
        <button
          type="button"
          onClick={() => v.scrollToIndex(queued.length - 1, { align: "end" })}
          className="absolute bottom-2 left-1/2 flex h-6 -translate-x-1/2 items-center gap-1 rounded-full bg-float px-2.5 text-xs shadow-float hover:bg-generic"
          data-testid="items-new-pill"
        >
          <ArrowDownIcon className="size-3" aria-hidden /> {fresh} new
        </button>
      )}
    </div>
  );
}

function IconToggle({ label, pressed, onClick, icon: Icon, testid }: { label: string; pressed: boolean; onClick: () => void; icon: IconComponent; testid: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn("flex size-6 items-center justify-center rounded transition-colors", pressed ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
      data-testid={testid}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function kindIconOf(item: StudioItem, fallback: ComponentType<{ className?: string }>): { icon: ComponentType<{ className?: string }>; label: string } {
  const kind = itemKind(item);
  return kind ? { icon: KINDS[kind].icon, label: KINDS[kind].label } : { icon: fallback, label: "" };
}

function Empty({ query, filter, total, noun }: { query: string; filter: string; total: number; noun: string }) {
  const many = pluralWord(2, noun);
  if (query.trim()) return <EmptyState size="s" art="no-results" title={`No ${many} found`} description={`Nothing matches “${query.trim()}”.`} />;
  if (filter === "todo") return <EmptyState size="s" art="success" title={`All ${plural(total, noun)} done`} />;
  if (filter === "review") return <EmptyState size="s" art="success" title="Nothing needs review" />;
  if (filter === "done") return <EmptyState size="s" art="task" title={`No ${many} done yet`} />;
  return <EmptyState size="s" art="dataset" title={`No ${many} here`} />;
}

interface RowEvents {
  onChoose: (index: number) => void;
  onEnter: (index: number, el: HTMLElement) => void;
  onLeave: () => void;
  onMenu: (index: number, e: { clientX: number; clientY: number; preventDefault: () => void }) => void;
}

function QueueRow({ item, index, current, state, suffix, kindIcon, thumb, onChoose, onEnter, onLeave, onMenu }: { item: StudioItem; index: number; current: boolean; state: ItemState; suffix: string; kindIcon?: { icon: ComponentType<{ className?: string }>; label: string }; thumb?: ReactNode } & RowEvents) {
  const s = STATE[state];
  const count = bundleCount(item);
  const trashed = isTrashedItem(item);
  return (
    <button
      onClick={() => onChoose(index)}
      onMouseEnter={(e) => onEnter(index, e.currentTarget)}
      onMouseLeave={onLeave}
      onContextMenu={(e) => onMenu(index, e)}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
        current ? "bg-selection text-foreground" : "text-[var(--text-secondary)] hover:bg-generic hover:text-foreground",
        trashed && "opacity-60",
      )}
      aria-current={current}
      role="listitem"
      data-testid="file-row"
      data-state={state}
      data-trashed={trashed || undefined}
    >
      <s.icon className={cn("h-3.5 w-3.5 shrink-0", s.className)} aria-label={s.label} />
      {thumb}
      {kindIcon && <kindIcon.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={kindIcon.label} data-testid="file-kind" />}
      <span className="min-w-0 truncate" data-testid="file-name">{item.name}</span>
      {suffix && <span className="min-w-0 flex-1 truncate text-xs text-hint" data-testid="file-suffix">{suffix}</span>}
      {!suffix && <span className="flex-1" />}
      {count && <span className="tnum shrink-0 text-xs text-hint">{count}</span>}
      {trashed && <InTrashBadge />}
    </button>
  );
}

function FoldersView({
  items,
  indices,
  states,
  itemIndex,
  suffixes,
  mixed,
  fallbackIcon,
  filtering,
  onChoose,
  onEnter,
  onLeave,
  onMenu,
  onKey,
  empty,
}: {
  items: StudioItem[];
  indices: number[];
  states: Map<string, ItemState>;
  itemIndex: number;
  suffixes: string[];
  mixed: boolean;
  fallbackIcon: ComponentType<{ className?: string }>;
  filtering: boolean;
  onKey: (e: React.KeyboardEvent) => boolean;
  empty: ReactNode;
} & RowEvents) {
  const tree = useMemo(() => itemTree(items, states, indices), [items, states, indices]);
  const handle = useRef<FileTreeHandle>(null);
  const activePart = useStudio((s) => s.activePart);

  const data = useMemo(() => {
    const leaf = (index: number): FileTreeNode => {
      const item = items[index];
      const state = states.get(item.id) ?? "todo";
      const kind = mixed ? kindIconOf(item, fallbackIcon) : null;
      const count = bundleCount(item);
      return {
        id: `${ITEM}${index}`,
        name: item.name,
        title: "",
        icon: STATE_TREE_ICON[state],
        badges: suffixes[index] ? <span className="max-w-32 truncate text-xs" data-testid="file-suffix">{suffixes[index]}</span> : undefined,
        count: count ?? undefined,
        status: kind ? <kind.icon className="size-3.5 text-hint" aria-label={kind.label} data-testid="file-kind" /> : undefined,
        // A subject's sequences (or a study's series) as rows under it; click shows that one.
        children:
          item.parts && item.parts.length > 1
            ? item.parts.map((p) => ({ id: partId(index, p.key), name: p.label, title: p.role === "reference" ? "Show the reference overlay" : `Show ${p.label}`, icon: p.role === "reference" ? MaskFileIcon : FileIcon }))
            : undefined,
      };
    };
    const dir = (d: ItemDir): FileTreeNode => ({
      id: d.id,
      name: d.name,
      icon: FolderIcon,
      openIcon: FolderOpenIcon,
      count: `${d.done}/${d.total}`,
      children: [
        ...d.dirs.map(dir),
        ...d.leaves.map((l) => {
          if (l.kind === "item") return leaf(l.index);
          const done = l.indices.filter((i) => states.get(items[i].id) === "annotated").length;
          return { id: l.id, name: l.name, icon: FolderIcon, openIcon: FolderOpenIcon, count: `${done}/${l.indices.length}`, children: l.indices.map(leaf) } satisfies FileTreeNode;
        }),
      ],
    });
    return dir(tree).children ?? [];
  }, [tree, items, states, suffixes, mixed, fallbackIcon]);

  // Folders open at mount: all of them when there are few (or while filtering), else the way to the current item.
  const allDirs = useMemo(() => {
    const out: string[] = [];
    const walk = (d: ItemDir) => {
      for (const c of d.dirs) {
        out.push(c.id);
        walk(c);
      }
      for (const l of d.leaves) if (l.kind === "run") out.push(l.id);
      for (const l of d.leaves) if (l.kind === "item" && l.index === itemIndex && items[l.index]?.parts) out.push(`${ITEM}${l.index}`);
    };
    walk(tree);
    return out;
  }, [tree, itemIndex, items]);
  const initialOpen = useMemo(() => (filtering || allDirs.length <= 24 ? allDirs : dirsAbove(tree, itemIndex)), [filtering, allDirs, tree, itemIndex]);
  const key = filtering ? `f:${indices.join(",")}` : "all";

  // Follow the current item (N, arrows, the decision bar): open its folders and scroll to it.
  const current = `${ITEM}${itemIndex}`;
  const currentPart = activePart && items[itemIndex]?.parts?.some((p) => p.key === activePart && p.role !== "reference") ? partId(itemIndex, activePart) : current;
  useEffect(() => {
    const api = handle.current?.api();
    if (!api?.get(current)) return;
    api.openParents(current);
    api.scrollTo(current);
  }, [current]);

  if (!indices.length) return <>{empty}</>;
  return (
    <div className="min-h-0 flex-1 px-1.5 pb-2" data-testid="items-tree">
      <FileTree
        key={key}
        ref={handle}
        data={data}
        selectedId={currentPart}
        initialOpen={initialOpen}
        aria-label="Items"
        onKey={onKey}
        onSelect={(ids) => {
          const id = ids[0];
          if (id?.startsWith(ITEM)) onChoose(Number(id.slice(ITEM.length)));
          else if (id?.startsWith(PART)) {
            const { index, key } = parsePart(id);
            if (index !== itemIndex) onChoose(index);
            useStudio.getState().setActivePart(key);
          }
          else if (id) handle.current?.api()?.get(id)?.toggle();
        }}
        onContextMenu={(id, e) => id.startsWith(ITEM) && onMenu(Number(id.slice(ITEM.length)), e)}
        rowProps={(n) => {
          if (n.id.startsWith(PART)) return { "data-testid": "part-row", "data-part": parsePart(n.id).key };
          if (!n.id.startsWith(ITEM)) return { "data-testid": "folder-row" };
          const index = Number(n.id.slice(ITEM.length));
          return {
            "data-testid": "file-row",
            "data-state": states.get(items[index].id) ?? "todo",
            "data-trashed": isTrashedItem(items[index]) ? "true" : undefined,
            "aria-current": index === itemIndex ? "true" : "false",
            onMouseEnter: (e) => onEnter(index, e.currentTarget),
            onMouseLeave: onLeave,
          };
        }}
      />
    </div>
  );
}
