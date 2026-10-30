import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { buttonVariants } from "@studio/ui/ui/button";
import { Loader } from "@studio/ui/ui/loader";
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

export function FullPageMessage({ title, body, loading = false }: { title: string; body?: string; loading?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {loading && <Loader className="mb-2" />}
      <h1 className="text-body-2 font-semibold">{title}</h1>
      {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
      {!loading && (
        <Link to="/projects" className={buttonVariants({ variant: "outline", className: "mt-3" })}>Back to projects</Link>
      )}
    </div>
  );
}
