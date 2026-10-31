import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { SourceNode } from "@studio/contracts/types";
import { ChevronRightIcon, FolderIcon, LockIcon, MoreIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { DROP_HIGHLIGHT } from "./shared";

/**
 * The path bar (todo7 Phase 5, Finder path bar / Drive breadcrumb), the upgrade of the one in
 * today's Sources page (same `path-bar`, `path-current` and `path-more` test ids):
 * - every segment, the root included, is a drop target with the tree's drop look;
 * - the chevron after a segment opens a menu of that folder's subfolders;
 * - past `maxSegments`, the middle collapses into `…` with a menu of the hidden folders;
 * - the last segment's `⋯` holds the folder menu (`folderMenu`), or just Copy path.
 * Navigation is plain links (`hrefFor`), so ⌘-click opens a tab.
 */

export interface PathSegment {
  id: string;
  name: string;
  locked?: boolean;
}

export interface PathBarProps {
  /** The root's label, e.g. "Files". */
  rootLabel?: string;
  /** The root folder's id: makes the root a drop target and gives it a subfolder chevron. */
  rootId?: string | null;
  /** Folders below the root, top first; the last one is where you are. */
  segments: PathSegment[];
  /** URL of a folder (null: the root). */
  hrefFor: (id: string | null) => string;
  loading?: boolean;
  /** Search results are listed: the bar says so and hides the segments. */
  searching?: boolean;
  onCopyPath: () => void;
  /** Children of a folder for the chevron menus; only folders are shown. No chevron menus without it. */
  loadSubfolders?: (id: string) => Promise<SourceNode[]>;
  /** A drop on a segment (the page's drag controller decides move, copy or upload). */
  onDropOnSegment?: (id: string, dataTransfer: DataTransfer) => void;
  /** May this drag drop on that folder? Only `dataTransfer.types` is readable during a drag. Default: yes. */
  acceptsDrop?: (id: string, e: React.DragEvent) => boolean;
  /**
   * The `⋯` menu's items for the last segment (DropdownMenu items, e.g. `FilesMenuItems`). Replaces the
   * default "Copy path" item, so include Copy path in it.
   */
  folderMenu?: (segment: PathSegment) => ReactNode;
  /** Most segments shown before the middle collapses into `…` (default 4). */
  maxSegments?: number;
}

type Item = { type: "seg"; seg: PathSegment; last: boolean } | { type: "more"; hidden: PathSegment[] };
type Load = { state: "loading" } | { state: "error" } | { state: "ready"; folders: SourceNode[] };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function PathBar(props: PathBarProps) {
  const { rootLabel = "Files", rootId, segments, hrefFor, loading, searching, onCopyPath, loadSubfolders, onDropOnSegment, acceptsDrop, folderMenu, maxSegments = 4 } = props;
  const [over, setOver] = useState<string | null>(null);
  const [loads, setLoads] = useState<Record<string, Load>>({});

  const load = (id: string) => {
    if (!loadSubfolders || loads[id]?.state === "ready" || loads[id]?.state === "loading") return;
    setLoads((l) => ({ ...l, [id]: { state: "loading" } }));
    loadSubfolders(id).then(
      (rows) => setLoads((l) => ({ ...l, [id]: { state: "ready", folders: rows.filter((r) => r.kind === "folder").sort((a, b) => collator.compare(a.name, b.name)) } })),
      () => setLoads((l) => ({ ...l, [id]: { state: "error" } })),
    );
  };

  const dropProps = (id: string | null | undefined) => {
    if (!id || !onDropOnSegment) return {};
    const ok = (e: React.DragEvent) => (acceptsDrop ? acceptsDrop(id, e) : true);
    return {
      "data-drop-segment": id,
      onDragOver: (e: React.DragEvent) => {
        if (!ok(e)) return;
        e.preventDefault();
        if (over !== id) setOver(id);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOver((o) => (o === id ? null : o));
      },
      onDrop: (e: React.DragEvent) => {
        if (!ok(e)) return;
        e.preventDefault();
        setOver(null);
        onDropOnSegment(id, e.dataTransfer);
      },
    };
  };

  const items: Item[] = [];
  const cut = segments.length > maxSegments ? segments.length - (maxSegments - 2) : 0;
  segments.forEach((seg, i) => {
    if (cut && i >= 1 && i < cut) {
      if (i === 1) items.push({ type: "more", hidden: segments.slice(1, cut) });
      return;
    }
    items.push({ type: "seg", seg, last: i === segments.length - 1 });
  });
  // The folder a chevron after this item lists.
  const folderOf = (it: Item): PathSegment => (it.type === "seg" ? it.seg : it.hidden.at(-1)!);

  const chevron = (folderId: string | null | undefined, folderName: string, currentChildId?: string) =>
    loadSubfolders && folderId ? (
      <DropdownMenu onOpenChange={(o) => o && load(folderId)}>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex size-5 shrink-0 items-center justify-center rounded-sm text-hint hover:bg-generic hover:text-foreground" aria-label={`Folders in ${folderName}`} data-testid="path-chevron">
            <ChevronRightIcon className="size-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-56" data-testid="path-subfolders">
          <SubfolderItems load={loads[folderId]} hrefFor={hrefFor} currentId={currentChildId} onRetry={() => load(folderId)} />
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <ChevronRightIcon className="size-3 shrink-0 text-hint" aria-hidden />
    );

  const segClass = "truncate rounded-sm px-1 text-muted-foreground hover:bg-generic hover:text-foreground";
  return (
    <nav aria-label="Folder path" className="flex min-w-0 flex-1 items-center gap-0.5 text-sm" data-testid="path-bar">
      <Link to={hrefFor(null)} className={cn("shrink-0 rounded-sm px-1 hover:bg-generic", segments.length || searching ? "text-muted-foreground" : "font-semibold", over === rootId && DROP_HIGHLIGHT)} data-testid="path-root" {...dropProps(rootId)}>
        {searching ? "Search results" : rootLabel}
      </Link>
      {loading && <Skeleton className="ml-1 h-3 w-40" />}
      {!searching &&
        items.map((it, idx) => {
          const prevFolder = idx === 0 ? (rootId ? { id: rootId, name: rootLabel } : null) : folderOf(items[idx - 1]);
          const lead = chevron(prevFolder?.id, prevFolder?.name ?? rootLabel, folderOf(it).id);
          if (it.type === "more") {
            return (
              <span key="more" className="flex shrink-0 items-center gap-0.5">
                {lead}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" className={segClass} aria-label={`${it.hidden.length} more folders`} title={it.hidden.map((h) => h.name).join(" / ")} data-testid="path-collapsed" {...dropProps(it.hidden.at(-1)!.id)}>
                      …
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    {it.hidden.map((h, i) => (
                      <DropdownMenuItem key={h.id} asChild>
                        <Link to={hrefFor(h.id)} style={{ paddingLeft: 8 + i * 12 }}>
                          <FolderIcon className="text-hint" aria-hidden />
                          <span className="truncate">{h.name}</span>
                        </Link>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            );
          }
          const { seg, last } = it;
          return (
            <span key={seg.id} className={cn("flex items-center gap-0.5", last ? "min-w-0" : "min-w-0 max-w-[12rem] shrink")}>
              {lead}
              {last ? (
                <span className={cn("flex min-w-0 items-center gap-1 rounded-sm px-1 font-semibold", over === seg.id && DROP_HIGHLIGHT)} data-testid="path-current" {...dropProps(seg.id)}>
                  <span className="truncate">{seg.name}</span>
                  {seg.locked && <LockIcon className="size-3 shrink-0 text-hint" aria-label="Sample data" />}
                </span>
              ) : (
                <Link to={hrefFor(seg.id)} className={cn(segClass, over === seg.id && DROP_HIGHLIGHT)} data-testid="path-segment" data-node-id={seg.id} {...dropProps(seg.id)}>
                  {seg.name}
                </Link>
              )}
              {last && (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost-secondary" size="icon-sm" aria-label="Folder actions" data-testid="path-more">
                        <MoreIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-60">
                      {folderMenu ? (
                        folderMenu(seg)
                      ) : (
                        <DropdownMenuItem onSelect={onCopyPath} data-testid="path-copy">
                          Copy path
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </span>
          );
        })}
    </nav>
  );
}

function SubfolderItems({ load, hrefFor, currentId, onRetry }: { load: Load | undefined; hrefFor: (id: string | null) => string; currentId?: string; onRetry: () => void }) {
  if (!load || load.state === "loading")
    return (
      <div className="space-y-1 p-1" aria-busy>
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-2/3" />
      </div>
    );
  if (load.state === "error")
    return (
      <DropdownMenuItem
        onSelect={(e) => {
          e.preventDefault();
          onRetry();
        }}
      >
        Couldn't load the folders. Try again
      </DropdownMenuItem>
    );
  if (!load.folders.length) return <p className="px-2 py-1.5 text-sm text-muted-foreground">No folders inside</p>;
  return (
    <>
      {load.folders.map((f) => (
        <DropdownMenuItem key={f.id} asChild>
          <Link to={hrefFor(f.id)} className={cn(f.id === currentId && "font-semibold")} aria-current={f.id === currentId ? "location" : undefined} data-testid="path-subfolder">
            <FolderIcon className="text-hint" aria-hidden />
            <span className="truncate">{f.displayPath ?? f.name}</span>
            {f.locked && <LockIcon className="ml-auto size-3 text-hint" aria-label="Sample data" />}
          </Link>
        </DropdownMenuItem>
      ))}
    </>
  );
}
