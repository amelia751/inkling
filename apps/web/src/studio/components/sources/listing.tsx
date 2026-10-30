import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SourceNode } from "@studio/contracts/types";
import { ArrowDownIcon, ArrowUpIcon, DoneIcon } from "@studio/ui/icons";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { kindLabel, nodeIcon, nodeKind, STATUS_LABEL, statusReason } from "@/studio/lib/file-kinds";
import { formatBytes } from "@/studio/lib/format";
import { statusIcon } from "./source-tree";
import { usePreview } from "./queries";

/**
 * The listing of the folder shown (todo6 Phase 4.3): a virtualized list (36px rows, sticky
 * sortable header: Name, Kind, Size, Status, Added) or a grid of 4:3 thumbnails (min 168px).
 * Single click selects, double click (or Enter) opens. Arrow keys move the selection; the
 * Sources commands (Quick Look, open, parent) come from the page.
 */
export type SortKey = "name" | "kind" | "size" | "status" | "added";
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

export interface ListingHandle {
  focus: () => void;
  contains: (el: Element | null) => boolean;
}

interface Props {
  items: SourceNode[];
  loading: boolean;
  view: "list" | "grid";
  sort: Sort;
  onSort: (s: Sort) => void;
  selectedId: string | null;
  onSelect: (n: SourceNode) => void;
  onOpen: (n: SourceNode) => void;
  onContextMenu: (n: SourceNode, e: React.MouseEvent) => void;
  hasMore: boolean;
  onMore: () => void;
  /** Search results: show each file's folder in hint text. */
  showFolder?: boolean;
  /** Where a drop on a file row goes (the listed folder); folders take drops themselves. */
  dropFolder?: { id: string; label: string };
  empty: ReactNode;
}

const ROW = 36;
const TILE_MIN = 168;
const GAP = 12;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const STATUS_ORDER: Record<SourceNode["status"], number> = { privacy: 0, attention: 1, unsupported: 2, checking: 3, ready: 4 };

/** Folders first, then the chosen column; names compare in natural order, as the kernel does. */
export function sortItems(items: SourceNode[], s: Sort): SourceNode[] {
  const cmp = (a: SourceNode, b: SourceNode): number => {
    switch (s.key) {
      case "kind":
        return collator.compare(kindLabel(a), kindLabel(b));
      case "size":
        return (a.size ?? -1) - (b.size ?? -1);
      case "status":
        return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      case "added":
        return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
      default:
        return collator.compare(a.displayPath ?? a.name, b.displayPath ?? b.name);
    }
  };
  return [...items].sort((a, b) => Number(a.kind !== "folder") - Number(b.kind !== "folder") || s.dir * cmp(a, b) || collator.compare(a.name, b.name));
}

export const Listing = forwardRef<ListingHandle, Props>(function Listing(props, ref) {
  const { items, loading, view, selectedId, onSelect, onOpen, hasMore, onMore } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The grid sits in 12px gutters; tiles share what's left, never narrower than 168px.
  const inner = Math.max(0, width - 2 * GAP);
  const cols = view === "grid" ? Math.max(1, Math.floor((inner + GAP) / (TILE_MIN + GAP))) : 1;
  const tile = view === "grid" ? Math.floor((inner - (cols - 1) * GAP) / cols) : 0;
  const rowCount = Math.ceil(items.length / cols);
  const v = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => (view === "grid" ? Math.round((tile * 3) / 4) + 40 + GAP : ROW),
    overscan: 8,
    paddingStart: view === "grid" ? GAP : 0,
  });
  useEffect(() => v.measure(), [view, tile, v]);

  // Fetch the next page as the end comes into view.
  const last = v.getVirtualItems().at(-1)?.index ?? 0;
  useEffect(() => {
    if (hasMore && !loading && last >= rowCount - 10) onMore();
  }, [last, rowCount, hasMore, loading, onMore]);

  const index = items.findIndex((n) => n.id === selectedId);
  useImperativeHandle(ref, () => ({
    focus: () => scroller.current?.focus(),
    contains: (el) => !!el && !!scroller.current?.contains(el),
  }));

  const move = (delta: number) => {
    if (!items.length) return;
    const next = Math.min(items.length - 1, Math.max(0, index < 0 ? 0 : index + delta));
    onSelect(items[next]);
    v.scrollToIndex(Math.floor(next / cols));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const step: Record<string, number> = { ArrowDown: cols, ArrowUp: -cols, ...(view === "grid" ? { ArrowRight: 1, ArrowLeft: -1 } : {}), PageDown: cols * 10, PageUp: -cols * 10 };
    if (e.key in step) {
      e.preventDefault();
      move(step[e.key]);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(e.key === "Home" ? -items.length : items.length);
    }
  };

  const showSkeleton = loading && !items.length;
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      {view === "list" && <Header sort={props.sort} onSort={props.onSort} />}
      <div
        ref={scroller}
        tabIndex={0}
        role="grid"
        aria-label="Files"
        aria-rowcount={items.length}
        aria-multiselectable={false}
        aria-busy={loading || undefined}
        onKeyDown={onKeyDown}
        className="thin-scrollbar relative min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        data-testid="sources-listing"
        data-view={view}
      >
        {showSkeleton && <SkeletonRows view={view} />}
        {!showSkeleton && !items.length && <div className="p-6">{props.empty}</div>}
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((r) => (
            <div key={r.key} role="row" aria-rowindex={r.index + 1} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${r.start}px)` }}>
              {view === "list" ? (
                <ListRow n={items[r.index]} {...rowProps(props, items[r.index])} />
              ) : (
                <div className="flex px-3" style={{ gap: GAP }}>
                  {items.slice(r.index * cols, r.index * cols + cols).map((n) => (
                    <Tile key={n.id} n={n} width={tile} {...rowProps(props, n)} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

function rowProps(p: Props, n: SourceNode) {
  const drop = n.kind === "folder" ? { id: n.id, label: n.name } : p.dropFolder;
  return {
    selected: n.id === p.selectedId,
    showFolder: !!p.showFolder,
    attrs: {
      "data-node-id": n.id,
      "data-drop-id": drop?.id,
      "data-drop-label": drop?.label,
      "aria-selected": n.id === p.selectedId,
      onClick: () => p.onSelect(n),
      onDoubleClick: () => p.onOpen(n),
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        p.onSelect(n);
        p.onContextMenu(n, e);
      },
    },
  };
}

type RowProps = ReturnType<typeof rowProps> & { n: SourceNode };

// Name takes what's left; "Added" shows once the listing is wide enough (container query).
const COLS = "grid grid-cols-[minmax(0,1fr)_8.5rem_4.5rem_8.5rem] @2xl:grid-cols-[minmax(0,1fr)_10rem_5rem_9.5rem_5.5rem] items-center gap-3 px-3";

function Header({ sort, onSort }: { sort: Sort; onSort: (s: Sort) => void }) {
  const cell = (key: SortKey, label: string, right = false) => {
    const on = sort.key === key;
    const Arrow = sort.dir === 1 ? ArrowUpIcon : ArrowDownIcon;
    return (
      <button
        type="button"
        role="columnheader"
        aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
        onClick={() => onSort({ key, dir: on ? ((-sort.dir) as 1 | -1) : 1 })}
        className={cn("flex min-w-0 items-center gap-1 truncate text-left hover:text-foreground", right && "justify-end", on && "text-foreground")}
        data-testid={`sort-${key}`}
      >
        {label}
        {on && <Arrow className="size-3" aria-hidden />}
      </button>
    );
  };
  return (
    <div role="row" className={cn(COLS, "sticky top-0 z-10 h-8 shrink-0 border-b border-border bg-background text-xs text-muted-foreground")}>
      {cell("name", "Name")}
      {cell("kind", "Kind")}
      {cell("size", "Size", true)}
      {cell("status", "Status")}
      <span className="hidden @2xl:flex">{cell("added", "Added")}</span>
    </div>
  );
}

function ListRow({ n, selected, showFolder, attrs }: RowProps) {
  const Icon = nodeIcon(n);
  const reason = statusReason(n);
  return (
    <div
      {...attrs}
      role="gridcell"
      title={reason ? `${n.displayPath ?? n.name}\n${reason}` : n.displayPath ?? n.name}
      className={cn(COLS, "h-9 cursor-default select-none text-body", selected ? "bg-selection" : "hover:bg-generic")}
      data-testid="listing-row"
      data-kind={n.kind}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className={cn("size-4 shrink-0", selected ? "icon-gradient" : "text-hint")} aria-hidden />
        <span className="min-w-0 truncate" data-testid="row-name">{n.displayPath ?? n.name}</span>
        {showFolder && n.folderPath && <span className="min-w-0 shrink truncate text-xs text-hint">{n.folderPath}</span>}
      </span>
      <span className="truncate text-muted-foreground">{kindLabel(n)}</span>
      <span className="tnum text-right text-muted-foreground">{n.kind === "folder" ? "—" : n.size === null ? "—" : formatBytes(n.size)}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {statusIcon(n.status) ?? <DoneIcon className="size-3.5 text-positive" aria-hidden />}
        <span className="truncate">{STATUS_LABEL[n.status]}</span>
      </span>
      <span className="tnum hidden truncate text-muted-foreground @2xl:block">{n.createdAt ? shortDate(n.createdAt) : "—"}</span>
    </div>
  );
}

function Tile({ n, width, selected, attrs }: RowProps & { width: number }) {
  const Icon = nodeIcon(n);
  return (
    <div {...attrs} role="gridcell" title={n.displayPath ?? n.name} className={cn("cursor-default select-none rounded-lg p-1.5", selected ? "bg-selection" : "hover:bg-generic")} style={{ width }} data-testid="listing-tile">
      <div className="relative flex items-center justify-center overflow-hidden rounded-md bg-canvas" style={{ height: Math.round(((width - 12) * 3) / 4) }}>
        <Thumb n={n} fallback={<Icon className="size-8 text-hint" aria-hidden />} />
        {statusIcon(n.status) && <span className="absolute right-1.5 top-1.5 rounded-sm bg-float p-0.5">{statusIcon(n.status)}</span>}
      </div>
      <p className="mt-1.5 truncate px-0.5 text-sm">{n.displayPath ?? n.name}</p>
      <p className="truncate px-0.5 text-xs text-hint">{kindLabel(n)}</p>
    </div>
  );
}

/** A tile's thumbnail: from inspection (or the image itself) once the tile is on screen. */
function Thumb({ n, fallback }: { n: SourceNode; fallback: ReactNode }) {
  const kind = nodeKind(n);
  const pictured = n.kind === "file" && n.status !== "privacy" && (kind === "image" || kind === "mask" || typeof n.facts.thumbnail === "string");
  const preview = usePreview(n.id, pictured);
  const url = preview.data?.thumbnailUrl ?? preview.data?.url;
  const [failed, setFailed] = useState(false);
  if (!pictured || !url || failed) return <>{fallback}</>;
  return <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-contain" />;
}

function SkeletonRows({ view }: { view: "list" | "grid" }) {
  if (view === "grid") {
    return (
      <div className="flex flex-wrap gap-3 p-3" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-40 w-[168px] rounded-lg" />
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className={cn(COLS, "h-9")}>
          <span className="flex items-center gap-2">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-3 w-2/3" />
          </span>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="ml-auto h-3 w-10" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="hidden h-3 w-14 @2xl:block" />
        </div>
      ))}
    </div>
  );
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}
