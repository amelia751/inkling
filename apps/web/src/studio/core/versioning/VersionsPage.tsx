import { useState } from "react";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { Alert } from "@studio/ui/ui/alert";
import { Loader } from "@studio/ui/ui/loader";
import { Link, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnnotateIcon, BranchIcon, MergeIcon, TagIcon, UndoIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Input } from "@studio/ui/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@studio/ui/ui/tabs";
import { AppLayout, PageHeading, PageContainer } from "@/studio/components/layout/app-layout";
import { studioUrl, versionReviewUrl } from "@/studio/lib/routes";
import { useStudio } from "@/studio/stores/studio";
import { api, type Review, type ReviewStatus } from "./api";
import { useVersioning, versioningEnabled } from "./session";
import { StudioSetupTab } from "./StudioSetupTab";

export const short = (oid?: string) => (oid ? oid.slice(0, 10) : "—");
const when = (iso: string) => new Date(iso).toLocaleString();

export const STATUS_THEME: Record<ReviewStatus, "normal" | "info" | "success" | "warning" | "danger" | "unknown"> = {
  DRAFT: "unknown", OPEN: "info", CHECKING: "info", READY: "success", BLOCKED: "danger", CONFLICTED: "warning", MERGING: "info", MERGED: "success", CLOSED: "unknown",
};

/** Shown instead of a versioning page when the kernel has no versioning service. */
export function VersioningOff({ children }: { children: React.ReactNode }) {
  const { projectId: routeProject, datasetId = routeProject ?? "" } = useParams();
  const projectId = routeProject ?? datasetId;
  const on = useQuery({ queryKey: ["versioning", datasetId, "enabled"], queryFn: () => versioningEnabled(datasetId), staleTime: Infinity });
  if (on.isLoading) return null;
  if (!on.data)
    return (
      <AppLayout>
        <div className="mx-auto max-w-xl p-8 text-center text-sm text-muted-foreground">
          <h2 className="mb-2 text-body-2 font-semibold text-foreground" data-testid="versioning-off">Versions aren't turned on</h2>
          Your work is still saved as you go. Branches, reviews and releases need the versioning service, which isn't running here: docs/running.md says how to start it.
        </div>
      </AppLayout>
    );
  return <>{children}</>;
}

/** History (commit list + revert), reviews, and releases of a versioned dataset. */
export function VersionsPage() {
  const { projectId: routeProject, datasetId = routeProject ?? "" } = useParams();
  const projectId = routeProject ?? datasetId;
  return (
    <VersioningOff>
      <AppLayout dataset={{ id: datasetId, title: datasetId }}>
        <PageContainer>
          <PageHeading
            title="Versions"
            description="Every save is a commit on your work branch. Changes reach main through a review; releases pin a commit for training and audit."
            actions={<Button variant="outline" size="lg" asChild><Link to={studioUrl(projectId, datasetId)}><AnnotateIcon />Back to annotating</Link></Button>}
          />
          <Tabs defaultValue="history">
            <TabsList>
              <TabsTrigger value="history">History</TabsTrigger>
              <TabsTrigger value="reviews">Reviews</TabsTrigger>
              <TabsTrigger value="releases">Releases</TabsTrigger>
              <TabsTrigger value="studio" data-testid="studio-setup-tab">Studio setup</TabsTrigger>
            </TabsList>
            <TabsContent value="history"><History datasetId={datasetId} /></TabsContent>
            <TabsContent value="reviews"><Reviews datasetId={datasetId} projectId={projectId} /></TabsContent>
            <TabsContent value="releases"><Releases datasetId={datasetId} /></TabsContent>
            <TabsContent value="studio"><StudioSetupTab datasetId={datasetId} /></TabsContent>
          </Tabs>
        </PageContainer>
      </AppLayout>
    </VersioningOff>
  );
}

function History({ datasetId }: { datasetId: string }) {
  const qc = useQueryClient();
  const current = useVersioning((s) => (s.datasetId === datasetId ? s.branch : null));
  const branches = useQuery({ queryKey: ["versioning", datasetId, "branches"], queryFn: () => api.branches(datasetId, datasetId) });
  const [ref, setRef] = useState<string | null>(null);
  const shown = ref ?? current ?? branches.data?.workBranch ?? "main";
  const branch = branches.data?.items.find((b) => b.name === shown);
  const commits = useQuery({ queryKey: ["versioning", datasetId, "commits", shown], queryFn: () => api.commits(datasetId, datasetId, shown), enabled: !!branches.data });
  const [error, setError] = useState<string | null>(null);
  const revert = useMutation({
    mutationFn: (target: string) => api.revert(datasetId, datasetId, { branch: shown, expected_head: branch!.commit_oid, target_oid: target }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["versioning", datasetId] });
      // The Studio reloads this branch the next time it opens.
      void qc.invalidateQueries({ queryKey: ["annotations", datasetId] });
      if (useStudio.getState().projectId === datasetId) useStudio.setState({ projectId: null });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <BranchIcon className="size-4 text-muted-foreground" />
        {(branches.data?.items ?? []).map((b) => (
          <Button key={b.name} size="sm" variant="ghost-secondary" selected={b.name === shown} onClick={() => setRef(b.name)} className="font-mono text-xs">{b.name}</Button>
        ))}
      </div>
      {error && <Alert theme="danger" className="mb-3">{error}</Alert>}
      <Card className="divide-y divide-border" data-testid="commit-history">
        {(commits.data?.items ?? []).map((c, i) => (
          <div key={c.oid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-commit={c.oid}>
            <code className="font-mono text-xs text-muted-foreground">{short(c.oid)}</code>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{c.message || "(no message)"}</div>
              <div className="text-muted-foreground">
                {c.author_id}{c.on_behalf_of ? ` for ${c.on_behalf_of}` : ""} · {when(c.created_at)}
                {c.annotation_count !== undefined && ` · ${c.annotation_count} annotations`}
              </div>
            </div>
            <Badge theme={c.operation === "merge" ? "success" : c.operation === "revert" ? "warning" : "normal"}>{c.operation}</Badge>
            {i > 0 && branch && !branch.protected && (
              <Button size="sm" variant="outline" disabled={revert.isPending} onClick={() => revert.mutate(c.oid)} title="New commit whose content equals this one">
                <UndoIcon /> Revert to this
              </Button>
            )}
          </div>
        ))}
        {commits.isLoading && <p className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground"><Loader size="s" /> Loading</p>}
      </Card>
    </div>
  );
}

function Reviews({ datasetId, projectId }: { datasetId: string; projectId: string }) {
  const reviews = useQuery({ queryKey: ["versioning", datasetId, "reviews"], queryFn: () => api.reviews(datasetId, datasetId) });
  return (
    <Card className="mt-4 divide-y divide-border" data-testid="review-list">
      {(reviews.data?.items ?? []).map((r: Review) => (
        <Link key={r.id} to={versionReviewUrl(projectId, datasetId, r.id)} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm hover:bg-generic">
          <MergeIcon className="size-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{r.title}</div>
            <div className="text-muted-foreground">
              <code className="font-mono text-xs">{r.source_branch}</code> → <code className="font-mono text-xs">{r.target_branch}</code> · {r.author_id} · {when(r.created_at)}
            </div>
          </div>
          <Badge theme={STATUS_THEME[r.status]}>{r.status.toLowerCase()}</Badge>
        </Link>
      ))}
      {reviews.data?.items.length === 0 && <EmptyState size="m" art="review" title="No reviews yet" description={'Choose "Request review" in the Studio to have someone check the annotations before a release.'} />}
    </Card>
  );
}

function Releases({ datasetId }: { datasetId: string }) {
  const qc = useQueryClient();
  const releases = useQuery({ queryKey: ["versioning", datasetId, "releases"], queryFn: () => api.releases(datasetId, datasetId) });
  const [tag, setTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.release(datasetId, datasetId, tag.trim(), "main"),
    onSuccess: (r) => {
      setTag("");
      // The release pins its commit's Studio setup; say so when that isn't what runs now.
      setError(r.studioWarning ?? null);
      void qc.invalidateQueries({ queryKey: ["versioning", datasetId, "releases"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  return (
    <div className="mt-4">
      <div className="mb-3 flex items-center gap-2">
        <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Tag, e.g. v2" className="w-48" aria-label="Release tag" />
        <Button size="sm" disabled={!tag.trim() || create.isPending} onClick={() => create.mutate()}><TagIcon /> Release main</Button>
      </div>
      {error && <Alert theme="danger" className="mb-3">{error}</Alert>}
      <Card className="divide-y divide-border" data-testid="release-list">
        {(releases.data?.items ?? []).map((r) => (
          <div key={r.tag} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-release={r.tag}>
            <TagIcon className="size-4 text-muted-foreground" />
            <span className="font-medium">{r.tag}</span>
            <code className="font-mono text-xs text-muted-foreground">{short(r.commit_oid)}</code>
            {r.studio_tree && <code className="font-mono text-xs text-muted-foreground" title="Studio setup this release pins" data-testid="release-studio">studio {short(r.studio_tree)}</code>}
            <span className="flex-1 text-muted-foreground">{r.created_by} · {when(r.created_at)}</span>
            <Badge theme="clear">{r.retention_policy}</Badge>
          </div>
        ))}
        {releases.data?.items.length === 0 && <EmptyState size="m" art="release" title="No releases yet" description="A release pins a reviewed version of the annotations, so it can be exported and cited later." />}
      </Card>
    </div>
  );
}
