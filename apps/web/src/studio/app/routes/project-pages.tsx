import { useState } from "react";
import { Link, Navigate, useLocation, useParams, type Params } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AnnotateIcon } from "@studio/ui/icons";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { Card } from "@studio/ui/ui/card";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { StudioEntryEmptyState } from "@/studio/app/entry/empty-states";
import { NewStudioButton } from "@/studio/components/studio/NewStudioButton";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { api, projectKeys, useOverview } from "@/studio/lib/projects-api";
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

/** `/projects/:p/files/*` → `/projects/:p/sources/*`, same node id, query and hash. */
export function FilesRedirect() {
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
 * there are several, or "No Studio yet" with the composer when there is none (todo13 §3.1).
 */
export function StudioEntry() {
  const { projectId = "" } = useParams();
  const overview = useOverview(projectId);
  const o = overview.data;
  if (o?.resume) return <Navigate to={studioUrl(projectId, o.resume.taskId)} state={{ resume: true }} replace />;
  if (o && o.tasks.length === 1) return <Navigate to={studioUrl(projectId, o.tasks[0].id)} replace />;
  // todo13 §3.1: no Studio yet says so here, with the composer, instead of sending people away.
  if (o && o.tasks.length === 0)
    return (
      <AppLayout>
        <div className="mx-auto w-full max-w-3xl px-4 py-5 md:px-6 md:py-6">
          <StudioEntryEmptyState projectId={projectId} />
        </div>
      </AppLayout>
    );
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-3xl px-4 py-5 md:px-6 md:py-6">
        <PageHeading title="Open the Studio" description="Pick the task to work on. The Studio opens the right viewer for its data." actions={<NewStudioButton projectId={projectId} />} />
        {overview.isLoading && <Skeleton className="h-28 rounded-lg" />}
        {overview.error && <p className="text-sm text-muted-foreground">{String(overview.error)}</p>}
        {o && (
          <Card className="divide-y divide-border" data-testid="task-picker">
            {o.tasks.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-generic" data-testid="task-picker-row" data-state={t.state ?? "published"}>
                <Link to={studioUrl(projectId, t.id)} viewTransition className="flex min-w-0 flex-1 items-center gap-3">
                  <AnnotateIcon className="size-4 text-hint" />
                  <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
                  <span className="text-muted-foreground">{t.kind.replace("-", " ")}</span>
                </Link>
                {t.state === "draft" && <DraftPublish projectId={projectId} taskId={t.id} />}
              </div>
            ))}
          </Card>
        )}
      </div>
    </AppLayout>
  );
}

/** A boot's draft in the Studio list (todo11 D6): "Draft · Publish"; only a person publishes. */
function DraftPublish({ projectId, taskId }: { projectId: string; taskId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Badge theme="warning">Draft</Badge>
      <Button
        variant="ghost"
        size="xs"
        disabled={busy}
        data-testid="task-publish"
        title={error ?? undefined}
        onClick={() => {
          setBusy(true);
          api(`/tasks/${encodeURIComponent(taskId)}/publish`, { method: "POST" })
            .then(() => qc.invalidateQueries({ queryKey: projectKeys.overview(projectId) }))
            .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      >
        Publish
      </Button>
    </span>
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
            Nothing here yet. <Link className="underline" to={sourcesUrl(projectId)}>Open Sources</Link> or <Link className="underline" to={projectUrl(projectId, "studio")}>the Studio</Link>.
          </p>
        )}
      </div>
    </AppLayout>
  );
}
