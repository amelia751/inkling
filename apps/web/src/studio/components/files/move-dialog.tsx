import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SourceNode } from "@studio/contracts/types";
import { ArrowUpIcon, ChevronRightIcon, FolderIcon, HistoryIcon, LockIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Input } from "@studio/ui/ui/input";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { ReasonButton } from "./shared";

/**
 * Move to… / Copy to… (todo7 Phase 3): a folder picker, not a typed path. A breadcrumb of where
 * you are, the subfolders of that folder as a flat list (Patch's secret-scope picker), recent
 * destinations at the top of the first level, and "New folder" inside the dialog. The target is
 * the folder you're in (the breadcrumb's last segment); **Move here** is inert with a visible
 * reason when `validate` (or a locked folder) says no.
 *
 * Keyboard: ↑ ↓ Home End move in the list, Enter or → opens a folder, Backspace, ← or ⌘↑ go up,
 * ⌘Enter moves here, Esc closes. Focus starts in the list and stays there while you navigate.
 * Pure: folders come from `loadFolders`, every action goes out through a callback.
 */

export interface FolderRef {
  id: string;
  name: string;
  locked?: boolean;
}

export interface MoveDestination extends FolderRef {
  /** Its ancestors below the root, top first (for the breadcrumb after jumping there). */
  path: FolderRef[];
}

export interface MoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Changes the wording: "Move here" / "Copy here". Copy is also "Copy to…" from sample data. */
  mode: "move" | "copy";
  /** What is moving, for the title: one name, or a count. */
  itemCount: number;
  itemName?: string;
  /** The project's root folder ("Files"). */
  root: FolderRef;
  /** Where the dialog opens: the folders below the root down to the start folder, top first. Default: the root. */
  initialPath?: FolderRef[];
  /** The children of a folder; only `kind: "folder"` rows are shown. */
  loadFolders: (parentId: string) => Promise<SourceNode[]>;
  /** Recent destinations, shown above the root's folders. */
  recent?: MoveDestination[];
  /** Why this folder can't take the items (into itself, a descendant, a name clash…), or null. */
  validate?: (targetId: string) => string | null;
  /** Creates a folder; the dialog then opens it. Reject with an Error to show its message under the field. */
  onNewFolder?: (parentId: string, name: string) => Promise<FolderRef>;
  /** Live check of a new folder's name (D10), or null. Duplicates among the listed folders are caught already. */
  validateName?: (name: string) => string | null;
  /** Why "New folder" can't be used (e.g. "Needs the full stack"). */
  newFolderDisabledReason?: string | null;
  onConfirm: (targetId: string) => void;
  busy?: boolean;
  /** An error from the last confirm, shown above the buttons. */
  error?: string | null;
}

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; folders: SourceNode[] };
type Entry = { type: "recent"; dest: MoveDestination } | { type: "folder"; node: SourceNode };

export const LOCKED_TARGET = "Sample data can't be changed. Pick another folder";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function MoveDialog(props: MoveDialogProps) {
  const { open, onOpenChange, mode, itemCount, itemName, root, initialPath, loadFolders, recent = [], validate, onNewFolder, validateName, newFolderDisabledReason, onConfirm, busy, error } = props;
  const [path, setPath] = useState<FolderRef[]>([]);
  const [loads, setLoads] = useState<Record<string, Load>>({});
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const baseId = useId();

  // A fresh start each time it opens.
  useEffect(() => {
    if (!open) return;
    setPath(initialPath ?? []);
    setLoads({});
    setActive(0);
    setCreating(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only
  }, [open]);

  const here = path.at(-1) ?? root;
  const load = loads[here.id];
  const fetchFolders = useCallback(
    (id: string) => {
      setLoads((l) => ({ ...l, [id]: { state: "loading" } }));
      loadFolders(id).then(
        (rows) => setLoads((l) => ({ ...l, [id]: { state: "ready", folders: rows.filter((r) => r.kind === "folder").sort((a, b) => collator.compare(a.name, b.name)) } })),
        (e: unknown) => setLoads((l) => ({ ...l, [id]: { state: "error", message: e instanceof Error ? e.message : "Couldn't load the folders" } })),
      );
    },
    [loadFolders],
  );
  useEffect(() => {
    if (open && !loads[here.id]) fetchFolders(here.id);
  }, [open, here.id, loads, fetchFolders]);

  const folders = load?.state === "ready" ? load.folders : [];
  const entries: Entry[] = useMemo(() => [...(path.length === 0 ? recent.map((dest) => ({ type: "recent" as const, dest })) : []), ...folders.map((node) => ({ type: "folder" as const, node }))], [path.length, recent, folders]);
  const activeIndex = Math.min(active, Math.max(0, entries.length - 1));

  const reason = here.locked ? LOCKED_TARGET : (validate?.(here.id) ?? null);
  const go = (next: FolderRef[], focusId?: string) => {
    setPath(next);
    setCreating(false);
    setActive(0);
    pendingFocus.current = focusId ?? null;
    list.current?.focus();
  };
  // After going up, the folder we came from is the active row.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || load?.state !== "ready") return;
    const i = entries.findIndex((e) => e.type === "folder" && e.node.id === id);
    if (i >= 0) setActive(i);
    pendingFocus.current = null;
  }, [entries, load?.state]);

  const openEntry = (e: Entry) => {
    if (e.type === "recent") go([...e.dest.path, { id: e.dest.id, name: e.dest.name, locked: e.dest.locked }]);
    else go([...path, { id: e.node.id, name: e.node.name, locked: e.node.locked }]);
  };
  const up = () => {
    if (!path.length) return;
    go(path.slice(0, -1), here.id);
  };
  const confirm = () => {
    if (!reason && !busy) onConfirm(here.id);
  };

  // Keep the active row in view.
  useEffect(() => {
    list.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Enter" && mod) {
      e.preventDefault();
      confirm();
    } else if ((e.key === "ArrowUp" && mod) || e.key === "Backspace" || e.key === "ArrowLeft") {
      e.preventDefault();
      up();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (entries.length) setActive(Math.min(entries.length - 1, Math.max(0, activeIndex + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : Math.max(0, entries.length - 1));
    } else if ((e.key === "Enter" || e.key === "ArrowRight") && entries[activeIndex]) {
      e.preventDefault();
      openEntry(entries[activeIndex]);
    }
  };

  const verb = mode === "move" ? "Move" : "Copy";
  const what = itemName ? `“${itemName}”` : itemCount === 1 ? "1 item" : `${itemCount.toLocaleString()} items`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const firstFolder = entries.findIndex((e) => e.type === "folder");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-md gap-3 rounded-lg"
        data-testid="move-dialog"
        data-mode={mode}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          list.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="truncate pr-6 text-base">
            {verb} {what} to…
          </DialogTitle>
          <DialogDescription>Open the folder it should go in, then choose {verb} here.</DialogDescription>
        </DialogHeader>

        <Crumbs root={root} path={path} onGo={go} />

        <div className="relative">
          <div
            ref={list}
            role="listbox"
            tabIndex={0}
            aria-label={`Folders in ${here.name}`}
            aria-activedescendant={entries.length ? optionId(activeIndex) : undefined}
            aria-busy={load?.state === "loading" || undefined}
            onKeyDown={onKeyDown}
            className="thin-scrollbar h-64 overflow-y-auto rounded-md border border-border p-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            data-testid="move-dialog-list"
          >
            {creating && onNewFolder && (
              <NewFolderRow
                siblings={folders}
                validateName={validateName}
                onCancel={() => {
                  setCreating(false);
                  list.current?.focus();
                }}
                onCreate={async (name) => {
                  const f = await onNewFolder(here.id, name);
                  // Re-read the parent next time; the new folder is empty, so open it now.
                  setLoads((l) => {
                    const rest = { ...l };
                    delete rest[here.id];
                    return { ...rest, [f.id]: { state: "ready", folders: [] } };
                  });
                  go([...path, f]);
                }}
              />
            )}
            {load?.state === "loading" && (
              <div className="space-y-1 p-1" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            )}
            {load?.state === "error" && (
              <div className="space-y-2 p-3 text-sm" role="alert">
                <p className="text-danger">{load.message}</p>
                <Button variant="outline" size="sm" onClick={() => fetchFolders(here.id)}>
                  Try again
                </Button>
              </div>
            )}
            {entries.map((e, i) => {
              const head = e.type === "recent" && i === 0 ? "Recent" : e.type === "folder" && i === firstFolder && firstFolder > 0 ? `In ${here.name}` : null;
              const name = e.type === "recent" ? e.dest.name : e.node.name;
              const locked = e.type === "recent" ? e.dest.locked : e.node.locked;
              return (
                <div key={`${e.type}-${e.type === "recent" ? e.dest.id : e.node.id}`}>
                  {head && <div className="px-2 pb-0.5 pt-1.5 text-xs font-semibold uppercase tracking-wide text-hint" aria-hidden>{head}</div>}
                  <div
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === activeIndex}
                    data-index={i}
                    data-folder-id={e.type === "recent" ? e.dest.id : e.node.id}
                    data-testid={e.type === "recent" ? "move-dialog-recent" : "move-dialog-folder"}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      setActive(i);
                      openEntry(e);
                    }}
                    className={cn("flex h-7 cursor-default items-center gap-2 rounded-sm px-2 text-sm", i === activeIndex ? "bg-selection" : "hover:bg-generic")}
                  >
                    {e.type === "recent" ? <HistoryIcon className="size-4 shrink-0 text-hint" aria-hidden /> : <FolderIcon className="size-4 shrink-0 text-hint" aria-hidden />}
                    <span className="min-w-0 truncate">{name}</span>
                    {e.type === "recent" && e.dest.path.length > 0 && <span className="min-w-0 truncate text-xs text-hint">{e.dest.path.map((p) => p.name).join(" / ")}</span>}
                    {locked && <LockIcon className="size-3 shrink-0 text-hint" aria-label="Sample data" />}
                    <ChevronRightIcon className="ml-auto size-3 shrink-0 text-hint" aria-hidden />
                  </div>
                </div>
              );
            })}
            {load?.state === "ready" && !entries.length && !creating && <p className="px-3 py-6 text-center text-sm text-muted-foreground" data-testid="move-dialog-empty">No folders in {here.name}</p>}
          </div>
        </div>

        {(reason || error) && (
          <p className={cn("text-sm", error ? "text-danger" : "text-muted-foreground")} role={error ? "alert" : undefined} data-testid="move-dialog-reason">
            {error ?? reason}
          </p>
        )}

        <DialogFooter className="flex-row flex-wrap items-center gap-2 sm:space-x-0">
          {path.length > 0 && (
            <Button variant="ghost-secondary" size="icon" onClick={up} aria-label="Up one folder" title="Up one folder" data-testid="move-dialog-up">
              <ArrowUpIcon />
            </Button>
          )}
          {onNewFolder && (
            <ReasonButton variant="ghost-secondary" reason={newFolderDisabledReason ?? (here.locked ? LOCKED_TARGET : null)} onClick={() => setCreating(true)} data-testid="move-dialog-new-folder">
              {/* TODO(todo7-integration): swap to <NewFolderIcon> */}
              <FolderIcon /> New folder
            </ReasonButton>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="move-dialog-cancel">
              Cancel
            </Button>
            <ReasonButton reason={reason} loading={busy} onClick={confirm} data-testid="move-dialog-confirm">
              {verb} here
            </ReasonButton>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Root › … › parent › current; the middle collapses past three folders. Each segment is a button. */
function Crumbs({ root, path, onGo }: { root: FolderRef; path: FolderRef[]; onGo: (p: FolderRef[]) => void }) {
  const segs: { label: string; to: FolderRef[]; title?: string }[] = [{ label: root.name, to: [] }];
  const start = path.length > 3 ? path.length - 2 : 0;
  if (start > 0) segs.push({ label: "…", to: path.slice(0, start), title: path.slice(0, start).map((p) => p.name).join(" / ") });
  path.slice(start).forEach((p, i) => segs.push({ label: p.name, to: path.slice(0, start + i + 1) }));
  return (
    <nav aria-label="Folder path" className="flex min-w-0 items-center gap-0.5 text-sm" data-testid="move-dialog-breadcrumb">
      {segs.map((s, i) => {
        const last = i === segs.length - 1;
        return (
          <span key={i} className="flex min-w-0 items-center gap-0.5">
            {i > 0 && <ChevronRightIcon className="size-3 shrink-0 text-hint" aria-hidden />}
            <button
              type="button"
              onClick={() => onGo(s.to)}
              aria-current={last ? "location" : undefined}
              title={s.title ?? s.label}
              className={cn("max-w-[10rem] truncate rounded-sm px-1 py-0.5", last ? "font-semibold" : "text-muted-foreground hover:bg-generic hover:text-foreground")}
              data-testid="move-dialog-crumb"
            >
              {s.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function NewFolderRow({ siblings, validateName, onCreate, onCancel }: { siblings: SourceNode[]; validateName?: (name: string) => string | null; onCreate: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("Untitled folder");
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const errId = useId();
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const trimmed = name.trim();
  const clash = siblings.some((s) => s.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
  const problem = !trimmed ? "Give the folder a name" : clash ? `A folder named “${trimmed}” is already here` : (validateName?.(trimmed) ?? null);
  const err = serverError ?? (name !== "Untitled folder" || clash ? problem : null);
  const submit = async () => {
    if (problem || saving) return;
    setSaving(true);
    try {
      await onCreate(trimmed);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Couldn't make the folder");
      setSaving(false);
    }
  };
  return (
    <div className="px-1 pb-1" onKeyDown={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2">
        <FolderIcon className="size-4 shrink-0 text-hint" aria-hidden />
        <Input
          ref={input}
          value={name}
          inputSize="sm"
          disabled={saving}
          aria-label="New folder name"
          aria-invalid={!!err || undefined}
          aria-describedby={err ? errId : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setServerError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          data-testid="move-dialog-new-folder-input"
        />
      </div>
      {err && (
        <p id={errId} className="mt-1 pl-6 text-xs text-danger" data-testid="move-dialog-new-folder-error">
          {err}
        </p>
      )}
    </div>
  );
}
