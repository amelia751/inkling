import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { fetchAnnotations, fetchProjects } from "@/lib/api";

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
      {loading && <Spinner className="mb-1 size-5 text-muted-foreground" />}
      <h1 className="text-body-2 font-semibold">{title}</h1>
      {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
      {!loading && (
        <Link to="/" className={buttonVariants({ variant: "outline", className: "mt-3" })}>Back to datasets</Link>
      )}
    </div>
  );
}
