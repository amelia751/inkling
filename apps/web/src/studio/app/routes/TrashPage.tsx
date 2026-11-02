import { useState } from "react";
import { useParams } from "react-router";
import { AnnotateIcon, DatasetsIcon, DeleteIcon, RestoreIcon, SourcesIcon } from "@studio/ui/icons";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@studio/ui/ui/alert-dialog";
import { Badge } from "@studio/ui/ui/badge";
import { Button, buttonVariants } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { ErrorView } from "@/studio/app/routes/errors";
import { relativeTime } from "@/studio/components/files";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import {
  deletedByLabel,
  dependentsLine,
  emptyCountsLine,
  groupByBatch,
  KIND_LABEL,
  matchesFilter,
  useDestroyBatch,
  useEmptyProjectTrash,
  useProjectTrash,
  useRestoreBatch,
  type ProjectTrashItem,
  type TrashFilter,
  type TrashGroup,
  type TrashKind,
} from "@/studio/lib/trash-api";
import { useCan } from "@/studio/lib/use-can";

const FILTERS: { value: Exclude<TrashFilter, "collections">; label: string }[] = [
  { value: "all", label: "All" },
  { value: "sources", label: "Sources" },
  { value: "datasets", label: "Datasets" },
  { value: "studios", label: "Studios" },
];

const ICON: Record<TrashKind, typeof SourcesIcon> = { source: SourcesIcon, dataset: DatasetsIcon, collection: DatasetsIcon, studio: AnnotateIcon };

export const TRASH_EMPTY = "Nothing in Trash. Deleted things stay here for 30 days, then they're gone.";

/**
 * The project's Trash (todo16 M2): one row per deletion batch (a dataset row carries its
 * collections, Studios and annotations, D3). Restore puts the batch back (to the Sources root
 * when its folder is gone, and says so); Delete forever and Empty trash confirm first.
 */
export function TrashPage() {
  const { projectId = "" } = useParams();
  const [filter, setFilter] = useState<Exclude<TrashFilter, "collections">>("all");
  const trash = useProjectTrash(projectId, "all");
  const restore = useRestoreBatch(projectId);
  const destroy = useDestroyBatch(projectId);
  const empty = useEmptyProjectTrash(projectId);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ProjectTrashItem | null>(null);
  const all = trash.data?.items ?? [];
  const rows = groupByBatch(all.filter((i) => matchesFilter(i, filter)));
  const canRestore = useCan(projectId, "trash");
  const canDestroy = useCan(projectId, "destroy");
  // Pending per batch (todo18 B): one row's action doesn't disable the others.
  const busyBatch = (restore.isPending ? restore.variables : undefined) ?? (destroy.isPending ? destroy.variables : undefined);

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6" data-testid="trash-page">
        <PageHeading
          title="Trash"
          description="Deleted sources, datasets and Studios stay here for 30 days."
          actions={
            canDestroy.ok ? (
              <Button variant="outline" size="lg" disabled={!all.length || empty.isPending} onClick={() => setConfirmEmpty(true)} data-testid="trash-empty">
                <DeleteIcon /> Empty trash
              </Button>
            ) : undefined
          }
        />
        <SegmentedControl value={filter} onValueChange={setFilter} size="md" options={FILTERS.map((f) => ({ value: f.value, label: f.label, "data-testid": `trash-filter-${f.value}` }))} aria-label="Show" />
        <div className="mt-4">
          {trash.error ? (
            <ErrorView variant="section" error={trash.error} what="Trash" onRetry={() => void trash.refetch()} />
          ) : trash.isLoading ? (
            <div className="space-y-2" aria-busy>
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState art="trash" title={all.length ? "Nothing of this kind in Trash" : "Trash is empty"} description={TRASH_EMPTY} data-testid="trash-empty-state" />
          ) : (
            <Card className="divide-y divide-border overflow-hidden" role="list">
              {rows.map((g) => (
                <TrashRow
                  key={g.batchId}
                  group={g}
                  busy={busyBatch === g.batchId || empty.isPending}
                  onRestore={canRestore.ok ? () => restore.mutate(g.batchId) : undefined}
                  onDelete={canDestroy.ok ? () => setConfirmDelete({ ...g.head, name: g.label }) : undefined}
                />
              ))}
            </Card>
          )}
        </div>
      </div>

      <AlertDialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <AlertDialogContent data-testid="trash-empty-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Empty Trash?</AlertDialogTitle>
            <AlertDialogDescription>
              <span data-testid="trash-empty-counts">{emptyCountsLine(all)}</span> will be deleted for good, with everything they took with them. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={() => empty.mutate()} data-testid="trash-empty-confirm-button">
              Empty trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent data-testid="trash-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirmDelete?.name}” forever?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete && dependentsLine(confirmDelete.dependents) ? `It goes with ${dependentsLine(confirmDelete.dependents)}. ` : ""}This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              onClick={() => {
                if (confirmDelete) destroy.mutate(confirmDelete.batchId);
                setConfirmDelete(null);
              }}
              data-testid="trash-delete-confirm-button"
            >
              Delete forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

function TrashRow({ group, busy, onRestore, onDelete }: { group: TrashGroup; busy: boolean; onRestore?: () => void; onDelete?: () => void }) {
  const it = group.head;
  const Icon = ICON[it.kind];
  const deps = dependentsLine(it.dependents);
  const [open, setOpen] = useState(false);
  const many = group.members.length > 1;
  return (
    <div role="listitem" className="px-4 py-3 text-sm" data-testid="trash-row" data-kind={it.kind} data-batch-id={it.batchId}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Icon className="size-4 shrink-0 text-hint" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {many ? (
              <button type="button" className="truncate text-left font-medium hover:underline" title={group.label} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="trash-row-expand">
                {group.label}
              </button>
            ) : (
              <span className="truncate font-medium" title={it.name}>{it.name}</span>
            )}
            <Badge theme="unknown" size="xs">{KIND_LABEL[it.kind]}</Badge>
          </span>
          <span className="block truncate text-muted-foreground">
            {it.originalLocation ?? "Its folder is gone: restores to Sources"}
            {deps && !many && ` · with ${deps}`}
          </span>
        </span>
        <span className="text-muted-foreground" data-testid="trash-deleted-by">{deletedByLabel(it.trashedBy)}</span>
        <span className="text-muted-foreground" title={it.trashedAt}>{relativeTime(it.trashedAt)}</span>
        <span className="tnum text-muted-foreground" data-testid="trash-days-left">{it.daysLeft.toLocaleString()} {it.daysLeft === 1 ? "day" : "days"} left</span>
        {(onRestore || onDelete) && (
          <span className="flex gap-1">
            {onRestore && (
              <Button variant="outline" size="sm" disabled={busy} onClick={onRestore} data-testid="trash-restore">
                <RestoreIcon /> Restore
              </Button>
            )}
            {onDelete && (
              <Button variant="ghost" size="sm" className="text-danger hover:text-danger" disabled={busy} onClick={onDelete} data-testid="trash-delete-forever">
                <DeleteIcon /> Delete forever
              </Button>
            )}
          </span>
        )}
      </div>
      {many && open && (
        <ul className="mt-2 ml-8 space-y-0.5 text-muted-foreground" data-testid="trash-row-members">
          {group.members.map((m) => (
            <li key={m.id} className="truncate" title={m.name}>{m.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
