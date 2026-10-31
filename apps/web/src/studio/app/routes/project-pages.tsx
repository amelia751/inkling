import { Link, Navigate, useLocation, useParams, type Params } from "react-router";
import { AnnotateIcon } from "@studio/ui/icons";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { Card } from "@studio/ui/ui/card";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { useOverview } from "@/studio/lib/projects-api";
import { datasetUrl, filesRedirect, projectUrl, settingsUrl, sourcesUrl, studioUrl, versionReviewUrl } from "@/studio/lib/routes";

/**
 * Small project pages and routing glue (todo6 Phase 2): the Studio entry, the old
 * `/datasets/:id/…` redirects and the section frames later phases fill in.
 */

/** The old URLs keep working (the e2e contract): a seed's project, dataset and task share its id (D2). */
export function LegacyRedirect({ to }: { to: (id: string, params: Readonly<Params<string>>) => string }) {
  const params = useParams();
  return <Navigate to={to(params.datasetId ?? "", params)} replace />;
}

/** `/projects/:p/sources/*` → `/projects/:p/files/*` (todo7 D11), same node id, query and hash. */
export function SourcesRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={filesRedirect(pathname, search) + hash} replace />;
}

export const LEGACY = {
  studio: (id: string) => studioUrl(id, id),
  review: (id: string) => projectUrl(id, "review"),
  export: (id: string) => datasetUrl(id, id, "publish"),
  plugins: (id: string) => settingsUrl(id, "plugins"),
  versions: (id: string) => datasetUrl(id, id, "versions"),
  versionReview: (id: string, p: Readonly<Params<string>>) => versionReviewUrl(id, id, p.reviewId ?? ""),
};

/**
 * "Studio" in the project nav: the last-used task (resume), the only task, a picker when
 * there are several, or Datasets with a hint when there is none yet.
 */
export function StudioEntry() {
  const { projectId = "" } = useParams();
  const overview = useOverview(projectId);
  const o = overview.data;
  if (o?.resume) return <Navigate to={studioUrl(projectId, o.resume.taskId)} state={{ resume: true }} replace />;
  if (o && o.tasks.length === 1) return <Navigate to={studioUrl(projectId, o.tasks[0].id)} replace />;
  if (o && o.tasks.length === 0) return <Navigate to={`${projectUrl(projectId, "datasets")}?hint=no-task`} replace />;
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-3xl px-4 py-5 md:px-6 md:py-6">
        <PageHeading title="Open the Studio" description="Pick the task to work on. The Studio opens the right viewer for its data." />
        {overview.isLoading && <Skeleton className="h-28 rounded-lg" />}
        {overview.error && <p className="text-sm text-muted-foreground">{String(overview.error)}</p>}
        {o && (
          <Card className="divide-y divide-border" data-testid="task-picker">
            {o.tasks.map((t) => (
              <Link key={t.id} to={studioUrl(projectId, t.id)} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-generic">
                <AnnotateIcon className="size-4 text-hint" />
                <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
                <span className="text-muted-foreground">{t.kind.replace("-", " ")}</span>
              </Link>
            ))}
          </Card>
        )}
      </div>
    </AppLayout>
  );
}

/** Frame for a section whose page lands in a later todo6 phase; it routes, it doesn't pretend. */
export function SectionFrame({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) {
  const { projectId = "" } = useParams();
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6" data-testid={`section-${title.toLowerCase()}`}>
        <PageHeading title={title} description={description} />
        {children ?? (
          <p className="text-sm text-muted-foreground">
            Nothing here yet. <Link className="underline" to={sourcesUrl(projectId)}>Open Data</Link> or <Link className="underline" to={projectUrl(projectId, "studio")}>the Studio</Link>.
          </p>
        )}
      </div>
    </AppLayout>
  );
}
