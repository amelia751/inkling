import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SourceNode } from "@studio/contracts/types";
import { ArrowDownIcon, ArrowUpIcon, DoneIcon, LockIcon, StarFillIcon } from "@studio/ui/icons";
import { DROP_TARGET_CLASS, edgeAutoScroll } from "@studio/ui/drag";
import { nameStem } from "@studio/ui/file-names";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { kindLabel, nodeIcon, nodeKind, STATUS_LABEL, statusReason } from "@/studio/lib/file-kinds";
import { formatBytes } from "@/studio/lib/format";
import { statusIcon } from "./source-tree";
import { usePreview } from "./queries";

/**
 * The listing of the folder shown (todo6 Phase 4.3, todo7 Phases 2, 3 and 5): a virtualized list
 * (36px rows, sticky sortable header: Name, Kind, Size, Status, Added) or a grid of 4:3
 * thumbnails (min 168px). Click selects, ⇧/⌘ click extend it, ⇧↑↓ too, double click (or Enter)
 * opens. In the grid a drag on empty space draws a rubber band that selects the tiles it
 * touches (autoscrolling near the edges). Rows can be renamed in place (the Name cell), dragged
 * (the page's drag controller), and folders take drops. Cut rows are drawn at 50%.
 */
export type SortKey = "name" | "kind" | "size" | "status" | "added";
export interface Sort {
  key: SortKey;
  dir: 1 | -1;
}

export interface ListingHandle {
  focus: () => void;
  contains: (el: Element | null) => boolean;
  /** The row element of a node (for keyboard context menus). */
  rowOf: (id: string) => HTMLElement | null;
  /** The row with keyboard focus (the last one clicked or moved to). */
  focusedId: () => string | null;
  scrollTo: (id: string) => void;
}

interface Props {
  items: SourceNode[];
  loading: boolean;
  view: "list" | "grid";
  sort: Sort;
  onSort: (s: Sort) => void;
  /** The selection (shared with the tree for the listed folder). */
  selectedIds: readonly string[];
  /** A new selection; `focus` is the row that got it (the one clicked or moved to). */
  onSelectionChange: (ids: string[], focus?: SourceNode) => void;
  onOpen: (n: SourceNode) => void;
  /** Right-click on a row, before the page's context menu opens. */
  onRowContextMenu?: (n: SourceNode, e: React.MouseEvent) => void;
  hasMore: boolean;
  onMore: () => void;
  /** Search results: show each file's folder in hint text. */
  showFolder?: boolean;
  /** Where an OS-file drop on a file row goes (the listed folder); folders take drops themselves. */
  dropFolder?: { id: string; label: string };
  empty: ReactNode;

  /** Rows cut to the clipboard (drawn at 50%). */
  cutIds?: ReadonlySet<string> | readonly string[];
  /** The row whose name is being edited, and new rows not saved yet (Enter commits even an unchanged name). */
  editingId?: string | null;
  draftIds?: ReadonlySet<string>;
  validateName?: (name: string, n: SourceNode) => string | null;
  onRename?: (n: SourceNode, name: string) => void;
  onRenameCancel?: (n: SourceNode) => void;
  /** Drag props for a row (the page's drag controller), or undefined when it can't be dragged. */
  dragProps?: (n: SourceNode) => Record<string, unknown> | undefined;
  /** Drop-target attributes for a folder row (the page's drag controller). */
  dropAttrs?: (n: SourceNode) => Record<string, string> | undefined;
  /** The folder a drag is over now (highlighted). */
  dropTargetId?: string | null;
}

const ROW = 36;
const TILE_MIN = 168;
const GAP = 12;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const STATUS_ORDER: Record<SourceNode["status"], number> = { privacy: 0, attention: 1, unsupported: 2, checking: 3, ready: 4 };

/** Bytes shown for a row: a file's size, a folder's total (todo7 Phase 5), or null. */
export const rowBytes = (n: SourceNode): number | null => (n.kind === "file" ? n.size : (n.totalBytes ?? null));

/** Folders first, then the chosen column; names compare in natural order, as the kernel does. */
export function sortItems(items: SourceNode[], s: Sort): SourceNode[] {
  const cmp = (a: SourceNode, b: SourceNode): number => {
    switch (s.key) {
      case "kind":
        return collator.compare(kindLabel(a), kindLabel(b));
      case "size":
        return (rowBytes(a) ?? -1) - (rowBytes(b) ?? -1);
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

/** The ids between two rows (inclusive), in listing order. */
function range(items: SourceNode[], a: string | null, b: string): string[] {
  const i = a ? items.findIndex((n) => n.id === a) : -1;
  const j = items.findIndex((n) => n.id === b);
  if (j < 0) return [];
  if (i < 0) return [b];
  const [lo, hi] = i < j ? [i, j] : [j, i];
  return items.slice(lo, hi + 1).map((n) => n.id);
}

interface Band {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  base: string[];
}

export const Listing = forwardRef<ListingHandle, Props>(function Listing(props, ref) {
  const { items, loading, view, selectedIds, onSelectionChange, hasMore, onMore } = props;
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
  const tileRow = Math.round((tile * 3) / 4) + 40 + GAP;
  const rowCount = Math.ceil(items.length / cols);
  const v = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => (view === "grid" ? tileRow : ROW),
    overscan: 8,
    paddingStart: view === "grid" ? GAP : 0,
  });
  useEffect(() => v.measure(), [view, tile, v]);

  // Fetch the next page as the end comes into view.
  const last = v.getVirtualItems().at(-1)?.index ?? 0;
  useEffect(() => {
    if (hasMore && !loading && last >= rowCount - 10) onMore();
  }, [last, rowCount, hasMore, loading, onMore]);

  // Keyboard focus and the ⇧ anchor (the selection itself is the page's).
  const focus = useRef<string | null>(null);
  const anchor = useRef<string | null>(null);
  const selected = new Set(selectedIds);
  if (focus.current && !items.some((n) => n.id === focus.current)) focus.current = null;
  if (!focus.current && selectedIds.length) focus.current = selectedIds[selectedIds.length - 1];

  useImperativeHandle(ref, () => ({
    focus: () => scroller.current?.focus(),
    contains: (el) => !!el && !!scroller.current?.contains(el),
    rowOf: (id) => scroller.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`) ?? null,
    focusedId: () => focus.current,
    scrollTo: (id) => {
      const i = items.findIndex((n) => n.id === id);
      if (i >= 0) v.scrollToIndex(Math.floor(i / cols));
    },
  }));

  const select = (n: SourceNode, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    const mod = e.metaKey || e.ctrlKey;
    let ids: string[];
    if (e.shiftKey) {
      const r = range(items, anchor.current ?? focus.current, n.id);
      ids = mod ? [...new Set([...selectedIds, ...r])] : r;
    } else if (mod) {
      ids = selected.has(n.id) ? selectedIds.filter((x) => x !== n.id) : [...selectedIds, n.id];
      anchor.current = n.id;
    } else {
      ids = [n.id];
      anchor.current = n.id;
    }
    focus.current = n.id;
    onSelectionChange(ids, n);
  };

  const move = (delta: number, extend: boolean) => {
    if (!items.length) return;
    const index = items.findIndex((n) => n.id === focus.current);
    const next = Math.min(items.length - 1, Math.max(0, index < 0 ? 0 : index + delta));
    const n = items[next];
    if (extend) {
      anchor.current ??= focus.current ?? n.id;
      focus.current = n.id;
      onSelectionChange(range(items, anchor.current, n.id), n);
    } else {
      anchor.current = n.id;
      focus.current = n.id;
      onSelectionChange([n.id], n);
    }
    v.scrollToIndex(Math.floor(next / cols));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // React bubbles events through portals: keys pressed in a row's context menu (portaled to
    // <body>) arrive here too. Arrow keys there belong to the menu, not to the listing.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as Element).closest("input")) return;
    const step: Record<string, number> = { ArrowDown: cols, ArrowUp: -cols, ...(view === "grid" ? { ArrowRight: 1, ArrowLeft: -1 } : {}), PageDown: cols * 10, PageUp: -cols * 10 };
    if (e.key in step) {
      e.preventDefault();
      move(step[e.key], e.shiftKey);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      move(e.key === "Home" ? -items.length : items.length, e.shiftKey);
    }
  };

  // ---- Rubber band (grid): a pointer drag on empty space selects the tiles it touches ---------
  const [band, setBand] = useState<Band | null>(null);
  const bandRef = useRef<Band | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const tileAt = (i: number) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = GAP + c * (tile + GAP);
    const y = GAP + r * tileRow;
    return { x0: x, y0: y, x1: x + tile, y1: y + tileRow - GAP };
  };
  const hits = (b: Band): string[] => {
    const [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
    const [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
    const out: string[] = [];
    items.forEach((n, i) => {
      const t = tileAt(i);
      if (t.x0 < x1 && t.x1 > x0 && t.y0 < y1 && t.y1 > y0) out.push(n.id);
    });
    return out;
  };
  const toContent = (clientX: number, clientY: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top + el.scrollTop };
  };
  const updateBand = () => {
    const b = bandRef.current;
    const p = pointer.current;
    if (!b || !p) return;
    const c = toContent(p.x, p.y);
    const next = { ...b, x1: c.x, y1: c.y };
    bandRef.current = next;
    setBand(next);
    const ids = hits(next);
    onSelectionChange([...new Set([...next.base, ...ids])], undefined);
  };
  useEffect(() => {
    if (!band) return;
    // Autoscroll while the pointer is held near an edge, even without moving.
    const t = window.setInterval(() => {
      const p = pointer.current;
      if (p && edgeAutoScroll(scroller.current, p.x, p.y)) updateBand();
    }, 30);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per band
  }, [!!band]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (view !== "grid" || e.button !== 0 || !scroller.current) return;
    if ((e.target as Element).closest("[data-node-id]")) return;
    const c = toContent(e.clientX, e.clientY);
    const b: Band = { x0: c.x, y0: c.y, x1: c.x, y1: c.y, base: e.shiftKey || e.metaKey || e.ctrlKey ? [...selectedIds] : [] };
    bandRef.current = b;
    pointer.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    scroller.current.focus();
    setBand(b);
    if (!b.base.length && selectedIds.length) onSelectionChange([], undefined);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!bandRef.current) return;
    pointer.current = { x: e.clientX, y: e.clientY };
    updateBand();
  };
  const endBand = () => {
    bandRef.current = null;
    pointer.current = null;
    setBand(null);
  };

  const cut = props.cutIds instanceof Set ? props.cutIds : new Set(props.cutIds ?? []);
  const rowProps = (n: SourceNode): Omit<RowProps, "n"> => {
    const isFolder = n.kind === "folder";
    const drop = isFolder ? { id: n.id, label: n.name } : props.dropFolder;
    const editing = props.editingId === n.id;
    return {
      selected: selected.has(n.id),
      showFolder: !!props.showFolder,
      cut: cut.has(n.id),
      target: !!props.dropTargetId && props.dropTargetId === n.id,
      rename: editing ? <InlineRename n={n} draft={!!props.draftIds?.has(n.id)} validate={props.validateName} onSave={(name) => props.onRename?.(n, name)} onCancel={() => props.onRenameCancel?.(n)} /> : null,
      attrs: {
        "data-node-id": n.id,
        "data-drop-id": drop?.id,
        "data-drop-label": drop?.label,
        "aria-selected": selected.has(n.id),
        ...(isFolder ? props.dropAttrs?.(n) : undefined),
        ...(editing ? {} : props.dragProps?.(n)),
        onClick: (e: React.MouseEvent) => select(n, e),
        onDoubleClick: () => !editing && props.onOpen(n),
        onContextMenu: (e: React.MouseEvent) => {
          if (!selected.has(n.id)) select(n, { shiftKey: false, metaKey: false, ctrlKey: false });
          focus.current = n.id;
          props.onRowContextMenu?.(n, e);
        },
      },
    };
  };

  const showSkeleton = loading && !items.length;
  const bandBox = band && { left: Math.min(band.x0, band.x1), top: Math.min(band.y0, band.y1), width: Math.abs(band.x1 - band.x0), height: Math.abs(band.y1 - band.y0) };
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      {view === "list" && <Header sort={props.sort} onSort={props.onSort} />}
      <div
        ref={scroller}
        tabIndex={0}
        role="grid"
        aria-label="Files"
        aria-rowcount={items.length}
        aria-multiselectable
        aria-busy={loading || undefined}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endBand}
        onPointerCancel={endBand}
        className="thin-scrollbar relative min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        data-testid="sources-listing"
        data-fs-autoscroll=""
        data-view={view}
      >
        {showSkeleton && <SkeletonRows view={view} />}
        {!showSkeleton && !items.length && <div className="p-6">{props.empty}</div>}
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((r) => (
            <div key={r.key} role="row" aria-rowindex={r.index + 1} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${r.start}px)` }}>
              {view === "list" ? (
                <ListRow n={items[r.index]} {...rowProps(items[r.index])} />
              ) : (
                <div className="flex px-3" style={{ gap: GAP }}>
                  {items.slice(r.index * cols, r.index * cols + cols).map((n) => (
                    <Tile key={n.id} n={n} width={tile} {...rowProps(n)} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {bandBox && <div className="pointer-events-none absolute z-20 rounded-sm border border-ring bg-selection/40" style={bandBox} data-testid="rubber-band" aria-hidden />}
      </div>
    </div>
  );
});

interface RowProps {
  n: SourceNode;
  selected: boolean;
  showFolder: boolean;
  cut: boolean;
  /** A drag is over this folder. */
  target: boolean;
  /** The rename field, while the row is being renamed. */
  rename: ReactNode;
  attrs: Record<string, unknown>;
}

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

function Marks({ n }: { n: SourceNode }) {
  return (
    <>
      {n.starred && <StarFillIcon className="size-3 shrink-0 text-warning" aria-label="Starred" data-testid="row-starred" />}
      {n.locked && n.kind === "folder" && <LockIcon className="size-3 shrink-0 text-hint" aria-label="Sample data" />}
    </>
  );
}

function ListRow({ n, selected, showFolder, cut, target, rename, attrs }: RowProps) {
  const Icon = nodeIcon(n);
  const reason = statusReason(n);
  const bytes = rowBytes(n);
  return (
    <div
      {...attrs}
      role="gridcell"
      title={rename ? undefined : reason ? `${n.displayPath ?? n.name}\n${reason}` : n.displayPath ?? n.name}
      className={cn(COLS, "h-9 cursor-default select-none text-body", selected ? "bg-selection" : "hover:bg-generic", cut && "opacity-50", target && DROP_TARGET_CLASS)}
      data-testid="listing-row"
      data-kind={n.kind}
      data-cut={cut || undefined}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className={cn("size-4 shrink-0", selected ? "icon-gradient" : "text-hint")} aria-hidden />
        {rename ?? (
          <>
            <span className="min-w-0 truncate" data-testid="row-name">{n.displayPath ?? n.name}</span>
            <Marks n={n} />
            {showFolder && n.folderPath && <span className="min-w-0 shrink truncate text-xs text-hint">{n.folderPath}</span>}
          </>
        )}
      </span>
      <span className="truncate text-muted-foreground">{kindLabel(n)}</span>
      <span className="tnum text-right text-muted-foreground" data-testid="row-size">{bytes === null ? "—" : formatBytes(bytes)}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {statusIcon(n.status) ?? <DoneIcon className="size-3.5 text-positive" aria-hidden />}
        <span className="truncate">{STATUS_LABEL[n.status]}</span>
      </span>
      <span className="tnum hidden truncate text-muted-foreground @2xl:block">{n.createdAt ? shortDate(n.createdAt) : "—"}</span>
    </div>
  );
}

function Tile({ n, width, selected, cut, target, rename, attrs }: RowProps & { width: number }) {
  const Icon = nodeIcon(n);
  return (
    <div
      {...attrs}
      role="gridcell"
      title={rename ? undefined : n.displayPath ?? n.name}
      className={cn("cursor-default select-none rounded-lg p-1.5", selected ? "bg-selection" : "hover:bg-generic", cut && "opacity-50", target && DROP_TARGET_CLASS)}
      style={{ width }}
      data-testid="listing-tile"
      data-cut={cut || undefined}
    >
      <div className="relative flex items-center justify-center overflow-hidden rounded-md bg-canvas" style={{ height: Math.round(((width - 12) * 3) / 4) }}>
        <Thumb n={n} fallback={<Icon className="size-8 text-hint" aria-hidden />} />
        {statusIcon(n.status) && <span className="absolute right-1.5 top-1.5 rounded-sm bg-float p-0.5">{statusIcon(n.status)}</span>}
      </div>
      {rename ? (
        <div className="mt-1 px-0.5">{rename}</div>
      ) : (
        <p className="mt-1.5 flex min-w-0 items-center gap-1 px-0.5 text-sm">
          <span className="truncate">{n.displayPath ?? n.name}</span>
          <Marks n={n} />
        </p>
      )}
      <p className="truncate px-0.5 text-xs text-hint">{kindLabel(n)}</p>
    </div>
  );
}

/**
 * Rename in the Name cell (todo7 §2 Rename): the stem is selected on focus, Enter saves, Esc
 * cancels, blur saves (or cancels when the name is invalid or unchanged); validation runs live
 * with the sentence under the field.
 */
function InlineRename({ n, draft, validate, onSave, onCancel }: { n: SourceNode; draft: boolean; validate?: (name: string, n: SourceNode) => string | null; onSave: (name: string) => void; onCancel: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(n.name);
  const done = useRef(false);
  const errId = useId();
  const error = value.trim() === n.name ? null : (validate?.(value, n) ?? null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, n.kind === "file" ? nameStem(el.value).length : el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the field opens
  }, []);
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };
  const save = () => {
    if (done.current) return;
    const v = value.trim();
    if (!v || (v === n.name && !draft) || error) return cancel();
    done.current = true;
    onSave(v);
  };
  return (
    <span className="relative min-w-0 flex-1">
      <input
        ref={input}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        aria-label={`Rename ${n.name}`}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? errId : undefined}
        spellCheck={false}
        autoComplete="off"
        data-testid="listing-rename-input"
        className={cn("h-6 w-full min-w-0 rounded-sm border bg-background px-1 text-body outline-none", error ? "border-destructive" : "border-ring")}
        onBlur={save}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (!error) save();
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
      />
      {error && (
        <span id={errId} role="alert" className="absolute left-0 top-full z-30 mt-0.5 max-w-72 whitespace-normal rounded-md bg-popover px-2 py-1 text-xs text-destructive shadow-popup" data-testid="rename-error">
          {error}
        </span>
      )}
    </span>
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
  return <img src={url} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} className="h-full w-full object-contain" />;
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
