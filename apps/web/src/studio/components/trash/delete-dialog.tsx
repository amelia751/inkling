import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CloseIcon, DeleteIcon, MoreIcon, RenameIcon } from "@studio/ui/icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@studio/ui/ui/alert-dialog";
import { Button } from "@studio/ui/ui/button";
import { Input } from "@studio/ui/ui/input";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { projectTrashUrl } from "@/studio/lib/routes";
import { deleteResource, invalidateAfterTrash, KIND_LABEL, messageOf, movedToTrashToast, previewDelete, useRename, type DeletableKind, type Impact } from "@/studio/lib/trash-api";

/**
 * Delete = move to Trash (todo16 D2). The dialog loads the impact preview (`?dryRun=true`) and
 * lists what goes with it (D3) and which datasets lose items (D4); confirming moves the batch to
 * Trash and shows the "Moved to Trash" toast with Undo and Open Trash.
 */
export function DeleteDialog({ projectId, kind, id, name, open, onOpenChange, onDeleted }: { projectId: string; kind: DeletableKind; id: string; name: string; open: boolean; onOpenChange: (open: boolean) => void; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setImpact(null);
    setError(null);
    let live = true;
    previewDelete(projectId, kind, id)
      .then((r) => live && setImpact(r.impact))
      .catch((e) => live && setError(messageOf(e)));
    return () => {
      live = false;
    };
  }, [open, projectId, kind, id]);

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await deleteResource(projectId, kind, id);
      invalidateAfterTrash(qc, projectId);
      onOpenChange(false);
      onDeleted?.();
      movedToTrashToast({ qc, projectId, batchId: r.batchId, what: name, openTrash: () => navigate(projectTrashUrl(projectId)) });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="delete-dialog" data-kind={kind}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {KIND_LABEL[kind].toLowerCase()} “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>It moves to Trash with everything below. You can restore it for 30 days.</AlertDialogDescription>
        </AlertDialogHeader>
        <ImpactList impact={impact} error={error} self={id} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" loading={busy} disabled={!impact && !error} onClick={() => void confirm()} data-testid="delete-confirm">
            Move to Trash
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ImpactList({ impact, error, self }: { impact: Impact | null; error: string | null; self?: string }) {
  if (error) return <p className="text-sm text-danger" data-testid="delete-impact-error">{error}</p>;
  if (!impact) return <Skeleton className="h-10 w-full" />;
  const others = impact.items.filter((i) => i.id !== self);
  return (
    <div className="space-y-2 text-sm" data-testid="delete-impact">
      {others.length > 0 && (
        <>
          <p>Also moves to Trash:</p>
          <ul className="thin-scrollbar max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-border px-3 py-2">
            {others.map((i) => (
              <li key={`${i.kind}-${i.id}`} className="truncate">
                <span className="text-muted-foreground">{KIND_LABEL[i.kind as keyof typeof KIND_LABEL] ?? i.kind}</span> · {i.name}
              </li>
            ))}
          </ul>
        </>
      )}
      {impact.files > 0 && <p>{impact.files.toLocaleString()} {impact.files === 1 ? "file" : "files"}</p>}
      {impact.datasetsLosingItems.map((d) => (
        <p key={d.id} className="text-warning">
          Used by {d.name} ({d.items.toLocaleString()} {d.items === 1 ? "item" : "items"}): they show as In Trash there until you restore.
        </p>
      ))}
      {!others.length && !impact.files && !impact.datasetsLosingItems.length && <p className="text-muted-foreground">Nothing else is affected.</p>}
    </div>
  );
}

/** Rename in place (todo16 M2): a name that turns into an input; Enter saves, Escape cancels. */
export function RenameInPlace({ projectId, kind, id, name, className, canEdit = true, editing: controlled, onEditingChange, children }: { projectId: string; kind: DeletableKind; id: string; name: string; className?: string; canEdit?: boolean; editing?: boolean; onEditingChange?: (e: boolean) => void; children?: ReactNode }) {
  const [own, setOwn] = useState(false);
  const editing = controlled ?? own;
  const setEditing = (e: boolean) => (onEditingChange ? onEditingChange(e) : setOwn(e));
  const [value, setValue] = useState(name);
  const rename = useRename(projectId, kind);
  useEffect(() => setValue(name), [name]);
  const save = () => {
    const next = value.trim();
    setEditing(false);
    if (next && next !== name) rename.mutate({ id, name: next });
    else setValue(name);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") (setValue(name), setEditing(false));
  };
  if (!editing)
    return (
      <span className={className}>
        {children ?? <span className="truncate">{rename.isPending ? value : name}</span>}
        {canEdit && controlled === undefined && (
          <Button variant="ghost-secondary" size="icon-sm" aria-label={`Rename ${name}`} onClick={() => setEditing(true)} data-testid="rename-in-place">
            <RenameIcon />
          </Button>
        )}
      </span>
    );
  return (
    <span className={className}>
      <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} onBlur={save} aria-label={`New name for ${name}`} className="h-7" data-testid="rename-input" />
      <Button variant="ghost-secondary" size="icon-sm" aria-label="Save name" onMouseDown={(e) => e.preventDefault()} onClick={save}>
        <CheckIcon />
      </Button>
      <Button variant="ghost-secondary" size="icon-sm" aria-label="Cancel rename" onMouseDown={(e) => e.preventDefault()} onClick={() => (setValue(name), setEditing(false))}>
        <CloseIcon />
      </Button>
    </span>
  );
}

/**
 * The "…" menu on a dataset, collection or Studio (card menus, detail headers): Rename (in
 * place, through `onRename`) and Delete (the impact dialog, then the Moved to Trash toast).
 */
export function ResourceMenu({ projectId, kind, id, name, onRename, onDeleted, canEdit = true }: { projectId: string; kind: DeletableKind; id: string; name: string; onRename?: () => void; onDeleted?: () => void; canEdit?: boolean }) {
  const [deleting, setDeleting] = useState(false);
  if (!canEdit) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost-secondary" size="icon-sm" aria-label={`More for ${name}`} data-testid="resource-menu">
            <MoreIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onRename && (
            <DropdownMenuItem onSelect={onRename} data-testid="resource-rename">
              <RenameIcon /> Rename
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="text-danger" onSelect={() => setDeleting(true)} data-testid="resource-delete">
            <DeleteIcon /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteDialog projectId={projectId} kind={kind} id={id} name={name} open={deleting} onOpenChange={setDeleting} onDeleted={onDeleted} />
    </>
  );
}
