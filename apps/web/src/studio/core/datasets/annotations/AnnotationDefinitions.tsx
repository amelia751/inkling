import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { TaskSummary } from "@studio/contracts/types";
import type { LabelGroup } from "@studio/contracts/environment";
import { AnnotateIcon, TaskSetupIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { ErrorView } from "@/studio/app/routes/errors";
import { fetchTaskDocument } from "@/studio/lib/api";
import { envLabel, envOf } from "@/studio/lib/environment";
import { studioUrl, taskSetupUrl } from "@/studio/lib/routes";
import { groupKind } from "@/studio/lib/task-setup";
import type { DatasetViewProps } from "../DatasetLayout";
import { swatch } from "../model";

/**
 * Annotations (docs/datasets.md §7): what labels can exist for this data, per task. Datasets
 * defines what an annotation is; the Studio edits single annotations; Task setup changes the
 * labels. Classes are shown by their stable id; colour is an editor affordance only.
 */
export function AnnotationDefinitions({ projectId, dataset, canEdit }: DatasetViewProps) {
  if (!dataset.tasks.length)
    return (
      <Card>
        <EmptyState art="annotation" title="No annotation types yet" description="They come from a task's labels: the classes people can assign, and how they're drawn." data-testid="annotations-empty" />
      </Card>
    );
  return (
    <div className="flex flex-col gap-5" data-testid="annotation-definitions">
      <p className="max-w-2xl text-sm text-muted-foreground">Each task defines the labels people use on this dataset. Labels keep their id when their name or colour changes, so earlier annotations still mean the same thing.</p>
      {dataset.tasks.map((t) => <TaskLabels key={t.id} projectId={projectId} task={t} canEdit={canEdit} />)}
    </div>
  );
}

function TaskLabels({ projectId, task: t, canEdit }: { projectId: string; task: TaskSummary; canEdit: boolean }) {
  const doc = useQuery({ queryKey: ["tasks", t.id, "document"], queryFn: () => fetchTaskDocument(t.id), staleTime: 30_000 });
  const env = doc.data ? envOf(doc.data) : undefined;
  return (
    <Card className="overflow-hidden" data-testid="annotation-task" data-task-id={t.id}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <AnnotateIcon className="size-4 shrink-0 text-hint" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{t.title}</h2>
          <p className="truncate text-sm text-muted-foreground">{env ? `${envLabel(env)} annotation` : doc.isLoading ? "…" : "Setup not readable"}</p>
        </div>
        {canEdit && (
          <Button variant="outline" size="sm" asChild>
            <Link to={taskSetupUrl(projectId, t.id)}><TaskSetupIcon /> Task setup</Link>
          </Button>
        )}
        <Button size="sm" asChild>
          <Link to={studioUrl(projectId, t.id)}>Open Studio</Link>
        </Button>
      </div>
      {doc.error ? (
        <ErrorView variant="section" error={doc.error} what="this task's labels" onRetry={() => void doc.refetch()} />
      ) : doc.isLoading ? (
        <div className="p-4"><Skeleton className="h-16 rounded-md" /></div>
      ) : !env?.labels.length ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">No labels yet. {canEdit ? "Add them in Task setup." : ""}</p>
      ) : (
        <div className="divide-y divide-border">
          {env.labels.map((g) => <LabelGroupRow key={g.name} group={g} />)}
        </div>
      )}
    </Card>
  );
}

function LabelGroupRow({ group: g }: { group: LabelGroup }) {
  return (
    <div className="px-4 py-3" data-testid="label-group">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3">
        <h3 className="font-medium">{g.name}</h3>
        <span className="text-sm text-muted-foreground">{groupKind(g)}</span>
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {g.classes.map((c, i) => (
          <li key={c.id}>
            <Badge theme="clear" size="sm" title={`Stable id: ${c.id}`} data-testid="label-class" data-label-id={c.id}>
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: swatch(c.color, i) }} aria-hidden />
              {c.name ?? c.id}
              {c.name && c.name !== c.id && <code className="font-mono text-xs text-muted-foreground">{c.id}</code>}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
