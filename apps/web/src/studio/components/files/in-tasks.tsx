import { Link } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { AnnotateIcon } from "@studio/ui/icons";
import type { Annotation, SourceNodeDetail } from "@studio/contracts/types";
import { fetchAnnotations, fetchTaskDocument } from "@/studio/lib/api";
import { studioUrl } from "@/studio/lib/routes";

type TaskState = "done" | "needs review" | "to do";

/** A file's state in one task: a person annotated it; only imported labels or AI suggestions; or nothing. */
export function taskState(annotations: Pick<Annotation, "itemId" | "provenance">[], itemIds: string[]): TaskState {
  const mine = annotations.filter((a) => itemIds.includes(a.itemId));
  if (mine.some((a) => a.provenance !== "imported" && a.provenance !== "ai-suggested")) return "done";
  return mine.length ? "needs review" : "to do";
}

/**
 * "In tasks" (todo8 D3, the way back from Data to the Studio): each task whose dataset holds
 * this file, its state there (`Pneumonia triage (done)`), and "Open in Studio", which opens
 * the task on this file's item (router state `{ itemId, nodeId }`, read by the Studio's
 * restore path). Self-contained so the Data inspector mounts it with one line.
 */
export function InTasks({ projectId, detail }: { projectId: string; detail: Pick<SourceNodeDetail, "id" | "kind" | "usedIn"> }) {
  const tasks = [...new Map(detail.usedIn.flatMap((d) => d.tasks).map((t) => [t.id, t])).values()];
  const docs = useQueries({ queries: tasks.map((t) => ({ queryKey: ["tasks", t.id, "document"], queryFn: () => fetchTaskDocument(t.id), staleTime: 60_000 })) });
  const anns = useQueries({ queries: tasks.map((t) => ({ queryKey: ["tasks", t.id, "annotations"], queryFn: () => fetchAnnotations(t.id).then((d) => d.annotations), staleTime: 30_000 })) });
  if (detail.kind !== "file" || !tasks.length) return null;
  return (
    <section data-testid="in-tasks">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-hint">In tasks</h3>
      <ul className="space-y-1.5">
        {tasks.map((t, i) => {
          const asset = docs[i].data?.assets.find((a) => a.nodeId === detail.id);
          const itemIds = asset ? [asset.path, ...(asset.subject ? [asset.subject] : [])] : [];
          const state = asset && anns[i].data ? taskState(anns[i].data, itemIds) : null;
          return (
            <li key={t.id} className="flex items-center gap-2" data-testid="in-task-row">
              <AnnotateIcon className="size-3.5 shrink-0 text-hint" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {t.title}
                {state && <span className="text-muted-foreground"> ({state})</span>}
              </span>
              {asset && (
                <Link to={studioUrl(projectId, t.id)} state={{ itemId: asset.path, nodeId: detail.id }} className="shrink-0 text-brand hover:underline" data-testid="open-in-studio">
                  Open in Studio
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
