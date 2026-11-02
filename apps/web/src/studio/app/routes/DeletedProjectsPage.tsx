import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DeleteIcon, RestoreIcon } from "@studio/ui/icons";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@studio/ui/ui/alert-dialog";
import { Button, buttonVariants } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { Input } from "@studio/ui/ui/input";
import { Label } from "@studio/ui/ui/label";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { ErrorView } from "@/studio/app/routes/errors";
import { relativeTime } from "@/studio/components/files";
import { ImpactList } from "@/studio/components/trash/delete-dialog";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { projectKeys } from "@/studio/lib/projects-api";
import { deletedProjectsUrl, homeUrl, projectUrl } from "@/studio/lib/routes";
import { deletedByLabel, deleteProject, destroyDeletedProject, messageOf, previewDeleteProject, restoreProject, trashKeys, useDeletedProjects, type Impact } from "@/studio/lib/trash-api";

export const DELETED_PROJECTS_EMPTY = "No deleted projects. A deleted project stays here for 30 days, then it's gone.";

/** Deleted projects (todo16 D6): restore puts everything back; Delete forever is for org admins. */
export function DeletedProjectsPage() {
  const q = useDeletedProjects();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [forever, setForever] = useState<{ id: string; name: string } | null>(null);
  const done = () => (void qc.invalidateQueries({ queryKey: trashKeys.deletedProjects() }), void qc.invalidateQueries({ queryKey: projectKeys.all }));
  const restore = useMutation({
    mutationFn: restoreProject,
    onSuccess: (_r, id) => (done(), toast("Project restored", { action: { label: "Open", onClick: () => navigate(projectUrl(id)) } })),
    onError: (e) => toast(`Couldn't restore: ${messageOf(e)}`),
  });
  const destroy = useMutation({ mutationFn: destroyDeletedProject, onSuccess: () => (done(), toast("Deleted forever")), onError: (e) => toast(`Couldn't delete: ${messageOf(e)}`) });
  const list = q.data?.projects ?? [];
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-4xl px-4 py-5 md:px-6 md:py-6" data-testid="deleted-projects-page">
        <PageHeading title="Deleted projects" description="Deleted projects stay here for 30 days. Restoring one puts back everything in it." />
        {q.error ? (
          <ErrorView variant="section" error={q.error} what="deleted projects" onRetry={() => void q.refetch()} />
        ) : q.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : list.length === 0 ? (
          <EmptyState art="trash" title="No deleted projects" description={DELETED_PROJECTS_EMPTY} data-testid="deleted-projects-empty" />
        ) : (
          <Card className="divide-y divide-border overflow-hidden">
            {list.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm" data-testid="deleted-project-row" data-project-id={p.id}>
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                <span className="text-muted-foreground">{typeof p.trashedBy === "string" ? p.trashedBy : deletedByLabel(p.trashedBy)}</span>
                <span className="text-muted-foreground">{relativeTime(p.trashedAt)}</span>
                <span className="tnum text-muted-foreground">{p.daysLeft} {p.daysLeft === 1 ? "day" : "days"} left</span>
                <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => restore.mutate(p.id)} data-testid="deleted-project-restore">
                  <RestoreIcon /> Restore
                </Button>
                <Button variant="ghost" size="sm" className="text-danger hover:text-danger" onClick={() => setForever(p)} data-testid="deleted-project-forever">
                  <DeleteIcon /> Delete forever
                </Button>
              </div>
            ))}
          </Card>
        )}
      </div>
      <AlertDialog open={!!forever} onOpenChange={(o) => !o && setForever(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{forever?.name}” forever?</AlertDialogTitle>
            <AlertDialogDescription>Its sources, datasets, Studios and annotations go for good. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={() => (forever && destroy.mutate(forever.id), setForever(null))} data-testid="deleted-project-forever-confirm">
              Delete forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

/** Settings › Danger zone › Delete project: shows the impact and asks for the project's name. */
export function DeleteProjectDialog({ projectId, name, open, onOpenChange }: { projectId: string; name: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const [impact, setImpact] = useState<Impact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTyped("");
    setImpact(null);
    setError(null);
    let live = true;
    previewDeleteProject(projectId)
      .then((r) => live && setImpact(r.impact))
      .catch((e) => live && setError(messageOf(e)));
    return () => {
      live = false;
    };
  }, [open, projectId]);
  const confirm = async () => {
    setBusy(true);
    try {
      await deleteProject(projectId);
      void qc.invalidateQueries({ queryKey: projectKeys.all });
      void qc.invalidateQueries({ queryKey: trashKeys.deletedProjects() });
      onOpenChange(false);
      navigate(homeUrl());
      toast(`Moved to Deleted projects: ${name}`, {
        duration: 10_000,
        action: {
          label: <span data-testid="toast-undo">Undo</span>,
          onClick: () => void restoreProject(projectId).then(() => (void qc.invalidateQueries({ queryKey: projectKeys.all }), navigate(projectUrl(projectId)))).catch((e) => toast(`Couldn't undo: ${messageOf(e)}`)),
        },
        cancel: { label: "Deleted projects", onClick: () => navigate(deletedProjectsUrl()) },
      });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="delete-dialog" data-kind="project">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>It moves to Deleted projects for 30 days: hidden from Home and search, and members lose access until it's restored.</AlertDialogDescription>
        </AlertDialogHeader>
        <ImpactList impact={impact} error={error} />
        <div className="space-y-1.5">
          <Label htmlFor="confirm-project-name">Type “{name}” to confirm</Label>
          <Input id="confirm-project-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-testid="delete-project-name" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" loading={busy} disabled={typed.trim() !== name.trim()} onClick={() => void confirm()} data-testid="delete-confirm">
            Delete project
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
