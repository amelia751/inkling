import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { buttonVariants } from "@studio/ui/ui/button";
import type { IllustrationName } from "@studio/ui/illustrations";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { fetchAnnotations, fetchProjects } from "@/studio/lib/api";

/**
 * The seed-era pages (review, export, plugins, versions) work on one dataset/task id. Under
 * `/projects/:projectId/…` that's the dataset or task in the path, else the project's own id
 * (a seed's project, dataset and task share it, todo6 D2).
 */
export function useDatasetParam(): string {
  const { datasetId, taskId, projectId } = useParams();
  return datasetId ?? taskId ?? projectId ?? "";
}

/** The project a page is in (`/projects/:projectId/…`), else the dataset id (legacy routes). */
export function useProjectParam(): string {
  const { projectId, datasetId } = useParams();
  return projectId ?? datasetId ?? "";
}

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: fetchProjects, staleTime: Infinity });
}

export function useProject(id: string) {
  const q = useProjects();
  return { ...q, project: q.data?.find((p) => p.id === id) };
}

/** Saved annotations for a dataset card; `enabled` skips datasets with nothing to open. */
export function useSavedAnnotations(id: string, enabled = true) {
  return useQuery({ queryKey: ["annotations", id, "summary"], queryFn: () => fetchAnnotations(id), enabled, staleTime: 10_000 });
}

/**
 * A whole-page state: loading, or an error/empty page (`kind` picks the illustration, as in
 * ErrorState). Errors with a thrown value should use `ErrorView` (routes/errors.tsx) instead,
 * which also chooses the title and the next step.
 */
export function FullPageMessage({ title, body, loading = false, kind, shape = "page" }: { title: string; body?: string; loading?: boolean; kind?: IllustrationName; shape?: "page" | "studio" }) {
  if (loading) return <PageSkeleton label={title} shape={shape} />;
  return (
    <EmptyState
      variant="page"
      art={kind}
      role={kind === "error" ? "alert" : undefined}
      title={title}
      description={body}
      actions={
        <Link to="/projects" className={buttonVariants({ variant: "outline", size: "lg" })}>
          Back to projects
        </Link>
      }
    />
  );
}

/**
 * A whole-page loading state shaped like what loads: a page header plus rows (`page`), or the
 * Studio's toolbar, item list and canvas (`studio`). `label` is for screen readers only.
 */
export function PageSkeleton({ label, shape = "page" }: { label: string; shape?: "page" | "studio" }) {
  if (shape === "studio")
    return (
      <div className="flex h-full min-h-0 flex-col" role="status" aria-busy aria-label={label}>
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <Skeleton className="h-6 w-32" />
          <div className="flex-1" />
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="size-7 rounded-md" />)}
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-60 shrink-0 flex-col gap-2 border-r p-3">
            {Array.from({ length: 8 }, (_, i) => <SkeletonText key={i} className={i % 3 === 2 ? "w-1/2" : "w-4/5"} />)}
          </div>
          <div className="flex-1 p-3"><Skeleton className="size-full rounded-lg" /></div>
          <div className="hidden w-64 shrink-0 flex-col gap-3 border-l p-3 lg:flex">
            <SkeletonText variant="subheader" className="w-24" />
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-8 w-full rounded-md" />)}
          </div>
        </div>
      </div>
    );
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-8" role="status" aria-busy aria-label={label}>
      <div className="flex flex-col gap-2">
        <SkeletonText variant="subheader" className="w-56" />
        <SkeletonText className="w-80" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
      </div>
    </div>
  );
}
