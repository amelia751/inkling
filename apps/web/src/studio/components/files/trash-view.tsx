import { useEffect, useState } from "react";
import type { TrashItem } from "@studio/contracts/types";
import { DeleteIcon, RestoreIcon } from "@studio/ui/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@studio/ui/ui/alert-dialog";
import { Button, buttonVariants } from "@studio/ui/ui/button";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { nodeIcon } from "@/studio/lib/file-kinds";
import { fullDate, plural, ReasonButton, relativeTime } from "./shared";

/**
 * The Trash view (todo7 Phase 4): a normal listing with a banner, "Items in Trash are deleted
 * after 30 days. **Empty Trash**". Columns Name, Original location, Deleted by, Deleted; Restore
 * and Delete forever per row and for a checked selection. Empty Trash and Delete forever confirm
 * first, and Empty Trash names the files whose bytes stay because something still uses them
 * (`keptBytes`, from `GET trash/empty/preview`, D8). Restoring needs no confirmation.
 */

export interface KeptBytes {
  name: string;
  /** e.g. "the LV v2 version uses it". */
  reason: string;
}

export interface TrashViewProps {
  items: TrashItem[];
  total: number;
  loading?: boolean;
  hasMore?: boolean;
  onMore?: () => void;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onRestore: (ids: string[]) => void;
  onDeleteForever: (ids: string[]) => void;
  onEmptyTrash: () => void;
  /** Called when the Empty Trash confirmation opens, so the caller can load `keptBytes`. */
  onEmptyTrashPreview?: () => void;
  /** undefined: not loaded yet (the dialog says it's checking); [] nothing is kept. */
  keptBytes?: KeptBytes[];
  emptying?: boolean;
  /** Set: every write here is inert with this reason (e.g. "Needs the full stack"). */
  disabledReason?: string | null;
  /** Opens a row (Quick Look still works in Trash; the Studio doesn't). */
  onOpen?: (item: TrashItem) => void;
}

// Name takes what's left; Deleted by and Original location show once there's room (container query).
const COLS = "grid grid-cols-[1.25rem_minmax(0,1fr)_5.5rem_3.75rem] @xl:grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,12rem)_5.5rem_3.75rem] @3xl:grid-cols-[1.25rem_minmax(0,1fr)_minmax(0,14rem)_8rem_6rem_3.75rem] items-center gap-3 px-4";

export function TrashView(props: TrashViewProps) {
  const { items, total, loading, hasMore, onMore, selectedIds, onSelectionChange, onRestore, onDeleteForever, onEmptyTrash, onEmptyTrashPreview, keptBytes, emptying, disabledReason, onOpen } = props;
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const selected = new Set(selectedIds);
  const allOn = items.length > 0 && items.every((i) => selected.has(i.id));
  const someOn = !allOn && items.some((i) => selected.has(i.id));
  const toggle = (id: string) => onSelectionChange(selected.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  useEffect(() => {
    if (confirmEmpty) onEmptyTrashPreview?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [confirmEmpty]);
  const nameOf = (ids: string[]) => (ids.length === 1 ? `“${items.find((i) => i.id === ids[0])?.name ?? "this item"}”` : plural(ids.length, "item"));

  return (
    <div className="@container flex h-full min-h-0 flex-col" data-testid="trash-view">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-generic px-4 py-2 text-sm" data-testid="trash-banner">
        <span className="min-w-0 text-muted-foreground">Items in Trash are deleted after 30 days.</span>
        <ReasonButton variant="link" size="sm" className="h-auto px-0 font-semibold" reason={disabledReason ?? (total === 0 ? "Trash is empty" : null)} onClick={() => setConfirmEmpty(true)} data-testid="trash-empty-button">
          Empty Trash
        </ReasonButton>
      </div>

      {selectedIds.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-1.5 text-sm" data-testid="trash-selection">
          <span className="tnum font-semibold">{selectedIds.length.toLocaleString()} selected</span>
          <ReasonButton variant="ghost" size="sm" reason={disabledReason} onClick={() => onRestore(selectedIds)} data-testid="trash-restore-selected">
            <RestoreIcon /> Restore
          </ReasonButton>
          <ReasonButton variant="ghost" size="sm" className={disabledReason ? undefined : "text-danger hover:text-danger"} reason={disabledReason} onClick={() => setConfirmDelete(selectedIds)} data-testid="trash-delete-selected">
            <DeleteIcon /> Delete forever
          </ReasonButton>
          <Button variant="ghost-secondary" size="sm" className="ml-auto" onClick={() => onSelectionChange([])}>
            Clear
          </Button>
        </div>
      )}

      {items.length > 0 && (
        <div className={cn(COLS, "h-8 shrink-0 border-b border-border text-xs font-semibold text-muted-foreground")} role="row">
          <Checkbox checked={allOn ? true : someOn ? "indeterminate" : false} onCheckedChange={(v) => onSelectionChange(v === true ? items.map((i) => i.id) : [])} aria-label="Select all" data-testid="trash-select-all" />
          <span>Name</span>
          <span className="hidden @xl:block">Original location</span>
          <span className="hidden @3xl:block">Deleted by</span>
          <span>Deleted</span>
          <span className="sr-only">Actions</span>
        </div>
      )}

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto" role="grid" aria-label="Trash" aria-rowcount={total} aria-busy={loading || undefined}>
        {loading && !items.length && (
          <div className="space-y-1 p-4" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        )}
        {!loading && !items.length && (
          <div className="flex flex-col items-center gap-2 px-4 py-16 text-center" data-testid="trash-empty-state">
            <DeleteIcon className="size-8 text-hint" aria-hidden />
            <p className="text-sm font-semibold">Trash is empty</p>
            <p className="max-w-xs text-sm text-muted-foreground">Things you delete stay here for 30 days, so you can put them back.</p>
          </div>
        )}
        {items.map((it) => {
          const Icon = nodeIcon(it);
          const on = selected.has(it.id);
          return (
            <div
              key={it.id}
              role="row"
              aria-selected={on}
              className={cn(COLS, "group h-9 text-sm", on ? "bg-selection" : "hover:bg-generic")}
              data-testid="trash-row"
              data-node-id={it.id}
              onDoubleClick={() => onOpen?.(it)}
            >
              <Checkbox checked={on} onCheckedChange={() => toggle(it.id)} aria-label={`Select ${it.name}`} />
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="size-4 shrink-0 text-hint" aria-hidden />
                <span className="truncate" title={it.name}>
                  {it.displayPath ?? it.name}
                </span>
              </span>
              <span className="hidden truncate text-muted-foreground @xl:block" title={it.originalLocation ?? undefined}>
                {it.originalLocation ?? <span className="text-hint">Folder is gone: restores to Files</span>}
              </span>
              <span className="hidden truncate text-muted-foreground @3xl:block">{it.trashedBy}</span>
              <span className="truncate text-muted-foreground" title={`${fullDate(it.trashedAt) ?? ""} · deleted for good in ${plural(it.purgeInDays, "day")}`}>
                {relativeTime(it.trashedAt)}
              </span>
              <span className="flex justify-end gap-0.5">
                <ReasonButton variant="ghost-secondary" size="icon-sm" reason={disabledReason} tip="Restore" aria-label={`Restore ${it.name}`} onClick={() => onRestore([it.id])} data-testid="trash-restore">
                  <RestoreIcon />
                </ReasonButton>
                <ReasonButton variant="ghost-secondary" size="icon-sm" reason={disabledReason} tip="Delete forever" aria-label={`Delete ${it.name} forever`} onClick={() => setConfirmDelete([it.id])} data-testid="trash-delete">
                  <DeleteIcon />
                </ReasonButton>
              </span>
            </div>
          );
        })}
        {hasMore && (
          <div className="p-3 text-center">
            <Button variant="outline" size="sm" loading={loading} onClick={onMore}>
              Show more
            </Button>
          </div>
        )}
      </div>

      <AlertDialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <AlertDialogContent data-testid="trash-empty-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Empty Trash?</AlertDialogTitle>
            <AlertDialogDescription>{plural(total, "item")} will be deleted for good. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          {keptBytes === undefined ? (
            <Skeleton className="h-4 w-2/3" />
          ) : (
            keptBytes.length > 0 && (
              <div className="space-y-1 text-sm" data-testid="trash-kept-bytes">
                <p>The names go, but the files below are kept because something still uses them:</p>
                <ul className="thin-scrollbar max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border px-3 py-2">
                  {keptBytes.map((k, i) => (
                    <li key={i} className="break-words">
                      <span className="font-semibold">{k.name}</span> <span className="text-muted-foreground">· Kept: {k.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              disabled={emptying}
              onClick={() => {
                onEmptyTrash();
              }}
              data-testid="trash-empty-confirm-button"
            >
              Empty Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent data-testid="trash-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete ? nameOf(confirmDelete) : ""} forever?</AlertDialogTitle>
            <AlertDialogDescription>This can't be undone. Files a dataset or a version still uses keep their bytes; only the names go.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (confirmDelete) onDeleteForever(confirmDelete);
                setConfirmDelete(null);
              }}
              data-testid="trash-delete-confirm-button"
            >
              Delete forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
