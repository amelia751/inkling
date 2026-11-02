import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { DatasetCollection, DatasetProfile, DatasetRelationship, DatasetSummary, TaskSummary } from "@studio/contracts/types";
import { ActivityIcon, AiIcon, AnnotateIcon, ArrowRightIcon, ChevronRightIcon, DoneIcon, HumanIcon, NoRelationshipIcon, RelationshipIcon, TagIcon } from "@studio/ui/icons";
import { Alert } from "@studio/ui/ui/alert";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { ErrorView } from "@/studio/app/routes/errors";
import { actorName, actorOf } from "@/studio/app/routes/ActivityPage";
import { relativeTime } from "@/studio/components/files";
import { fetchActivity, projectKeys } from "@/studio/lib/projects-api";
import { datasetUrl, projectTrashUrl, studioUrl, targetUrl } from "@/studio/lib/routes";
import { allFilesInTrash, useRestoreBatch } from "@/studio/lib/trash-api";
import { api as versioning } from "@/studio/core/versioning/api";
import { versioningEnabled } from "@/studio/core/versioning/session";
import type { DatasetViewProps } from "./DatasetLayout";
import { useDatasetAttention, usePipelineProblems } from "./api";
import { useAddData } from "./add-data";
import { RenameInPlace, ResourceMenu } from "@/studio/components/trash/delete-dialog";
import { byRisk, countOf, itemShape, pipelineAttention, rankAttention } from "./model";
import { IssueLine } from "./quality/DatasetQuality";
import { AttentionLine, CollectionThumb, DatasetSection, SuggestedBadge } from "./shared";

/**
 * A dataset's home (docs/datasets.md §4): "What is this dataset, and what needs my attention?"
 * Collections first, then the work, the problems, how things connect, what changed and the
 * latest release. No KPI tiles, and nothing the project Overview or the Studio already does.
 */
export function DatasetOverview({ projectId, dataset: d, profile, canEdit }: DatasetViewProps) {
  const p = profile.data;
  const addData = useAddData(projectId, d);
  const restore = useRestoreBatch(projectId);
  const trashBatches = (d as { filesTrashBatchIds?: string[] }).filesTrashBatchIds ?? [];
  return (
    <div className="flex flex-col gap-8" data-testid="dataset-overview">
      {p?.checking ? (
        <Alert theme="info" data-testid="dataset-checking">
          {p.checking.toLocaleString()} {p.checking === 1 ? "file is" : "files are"} still being checked. Collections and counts fill in as inspection finishes.
        </Alert>
      ) : null}
      {allFilesInTrash(d as { filesInTrash?: number; itemCount?: number }) && (
        <Card>
          <EmptyState
            art="trash"
            size="m"
            title="This dataset's files are in Trash"
            description="Its items show as In Trash until the files are restored. Trash keeps them for 30 days."
            actions={
              trashBatches.length && canEdit ? (
                <Button variant="outline" size="lg" disabled={restore.isPending} onClick={() => trashBatches.forEach((b) => restore.mutate(b))} data-testid="empty-files-in-trash-restore">
                  Restore files
                </Button>
              ) : (
                <Button variant="outline" size="lg" asChild>
                  <Link to={projectTrashUrl(projectId)} data-testid="empty-files-in-trash-restore">Open Trash</Link>
                </Button>
              )
            }
            data-testid="empty-files-in-trash"
          />
        </Card>
      )}
      <DatasetSection id="collections-heading" title="Collections" testid="dataset-collections">
        {profile.error ? (
          <Card>
            <ErrorView variant="section" error={profile.error} what="this dataset's collections" onRetry={() => void profile.refetch()} />
          </Card>
        ) : !p ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy data-testid="collections-loading">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[104px] rounded-lg" />)}
          </div>
        ) : p.collections.length === 0 ? (
          <Card>
            <EmptyState
              art="files"
              size="m"
              title="No data in this dataset yet"
              description={canEdit ? "Drop files here or describe what you need; they're added to this dataset." : "Nothing has been added yet. Ask a contributor to add files."}
              actions={
                canEdit && (
                  <Button variant="outline" size="lg" onClick={() => addData("drop")} data-testid="overview-add-data">
                    Add data
                  </Button>
                )
              }
              data-testid="overview-empty"
            />
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {p.collections.map((c) => <CollectionCard key={c.id} projectId={projectId} datasetId={d.id} collection={c} />)}
          </div>
        )}
      </DatasetSection>

      <div className="grid gap-8 lg:grid-cols-2 [&>*]:min-w-0">
        <ContinueWorking projectId={projectId} dataset={d} canEdit={canEdit} />
        <NeedsAttention projectId={projectId} datasetId={d.id} profile={p} />
      </div>

      <div className="grid gap-8 lg:grid-cols-2 [&>*]:min-w-0">
        <HowThingsConnect projectId={projectId} datasetId={d.id} profile={p} />
        <RecentlyChanged projectId={projectId} datasetId={d.id} />
      </div>

      <LatestRelease projectId={projectId} datasetId={d.id} canEdit={canEdit} />
    </div>
  );
}

function CollectionCard({ projectId, datasetId, collection: c }: { projectId: string; datasetId: string; collection: DatasetCollection }) {
  const shape = itemShape(c);
  return (
    <Link to={`${datasetUrl(projectId, datasetId, "fields")}?collection=${encodeURIComponent(c.id)}`} className="block rounded-lg" data-testid="collection-card" data-collection={c.id}>
      <Card view="selection" className="flex h-full gap-3 p-3">
        <CollectionThumb collection={c} className="size-16" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium" title={c.name}>{c.name}</p>
            {c.suggested && <SuggestedBadge what="This collection" />}
          </div>
          <p className="tnum truncate text-sm text-muted-foreground" data-testid="collection-count">
            {countOf(c.count, c.unit)}
            {c.files !== c.count && <> · {c.files.toLocaleString()} files</>}
          </p>
          {shape && <p className="truncate text-sm text-muted-foreground" title={shape}>{shape}</p>}
          {c.issues > 0 && <p className="mt-0.5 text-xs text-warning">{c.issues.toLocaleString()} with issues</p>}
        </div>
      </Card>
    </Link>
  );
}

/** The dataset's annotation work (each task opens a Studio): the way back into what was underway. */
function ContinueWorking({ projectId, dataset: d, canEdit = false }: { projectId: string; dataset: DatasetSummary; canEdit?: boolean }) {
  return (
    <DatasetSection id="continue-heading" title="Continue where you left off">
      {d.tasks.length === 0 ? (
        <Card>
          <EmptyState art="task" size="s" title="No tasks yet" description="A task opens this dataset in the Studio with its labels and tools." />
        </Card>
      ) : (
        <Card className="overflow-hidden" data-testid="dataset-tasks">
          <TaskList projectId={projectId} tasks={d.tasks} canEdit={canEdit} />
        </Card>
      )}
    </DatasetSection>
  );
}

export function TaskList({ projectId, tasks, canEdit = false }: { projectId: string; tasks: TaskSummary[]; canEdit?: boolean }) {
  return (
    <ul className="divide-y divide-border">
      {tasks.map((t) => (
        <TaskRow key={t.id} projectId={projectId} task={t} canEdit={canEdit} />
      ))}
    </ul>
  );
}

function TaskRow({ projectId, task: t, canEdit }: { projectId: string; task: TaskSummary; canEdit: boolean }) {
  const [renaming, setRenaming] = useState(false);
  return (
        <li className="flex items-center gap-3 px-4 py-2.5 text-sm" data-testid="task-row" data-task-id={t.id}>
          <AnnotateIcon className="size-4 shrink-0 text-hint" />
          <span className="min-w-0 flex-1">
            <RenameInPlace projectId={projectId} kind="studio" id={t.id} name={t.title} editing={renaming} onEditingChange={setRenaming} className="flex min-w-0 items-center gap-1">
              <span className="block truncate font-medium">{t.title}</span>
            </RenameInPlace>
            <span className="tnum block truncate text-muted-foreground">
              {t.annotatedItems.toLocaleString()} {t.annotatedItems === 1 ? "item" : "items"} annotated
              {t.state === "draft" && " · Draft"}
            </span>
          </span>
          <Button size="sm" asChild>
            <Link to={studioUrl(projectId, t.id)} data-testid="open-studio">Open Studio</Link>
          </Button>
          <ResourceMenu projectId={projectId} kind="studio" id={t.id} name={t.title} canEdit={canEdit} onRename={() => setRenaming(true)} />
        </li>
  );
}

/**
 * §4 "Needs attention": the dataset's problems by risk (not raw count), then what waits on a
 * person: suggested structure to confirm, a drop plan to decide, a pipeline run to look at.
 * "No problems found" speaks for the files; waiting decisions are listed apart.
 */
function NeedsAttention({ projectId, datasetId, profile }: { projectId: string; datasetId: string; profile?: DatasetProfile }) {
  const attention = useDatasetAttention(projectId, datasetId);
  const pipeline = usePipelineProblems(projectId);
  const top = profile ? byRisk(profile.issues).slice(0, 4) : [];
  // Issues already come from the profile; the attention read adds decisions and structure.
  const waiting = rankAttention([...(attention.data ?? { items: [] }).items.filter((i) => i.kind === "plan" || i.id.includes(":structure.")), ...pipelineAttention(pipeline.data, datasetId)]);
  return (
    <DatasetSection id="attention-heading" title="Needs attention" link={profile?.issues.length ? { to: datasetUrl(projectId, datasetId, "quality"), label: "All issues" } : undefined} testid="dataset-attention">
      {!profile ? (
        <Skeleton className="h-28 rounded-lg" />
      ) : top.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="dataset-all-clear">
          <DoneIcon className="size-4 text-positive" /> No problems found.
        </p>
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {top.map((i) => (
            <Link key={i.id} to={targetUrl(projectId, i.action.target)} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-generic" data-testid="dataset-attention-row" data-category={i.category}>
              <IssueLine issue={i} />
              <ChevronRightIcon className="size-4 shrink-0 text-hint" />
            </Link>
          ))}
        </Card>
      )}
      {waiting.length > 0 && (
        <Card className="mt-3 divide-y divide-border overflow-hidden" data-testid="dataset-waiting">
          {waiting.slice(0, 4).map((i) => <AttentionLine key={i.id} projectId={projectId} item={i} />)}
        </Card>
      )}
    </DatasetSection>
  );
}

function HowThingsConnect({ projectId, datasetId, profile }: { projectId: string; datasetId: string; profile?: DatasetProfile }) {
  const name = (id: string) => profile?.collections.find((c) => c.id === id)?.name ?? id;
  return (
    <DatasetSection id="connect-heading" title="How things connect" link={profile?.collections.length ? { to: datasetUrl(projectId, datasetId, "structure"), label: "View structure" } : undefined}>
      {!profile ? (
        <Skeleton className="h-20 rounded-lg" />
      ) : profile.relationships.length === 0 ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <NoRelationshipIcon className="mt-0.5 size-4 shrink-0 text-hint" />
          {profile.collections.length > 1 ? "No links between these collections yet. A table keyed by file or folder names can be linked in Explore." : "One collection, so nothing to link yet."}
        </p>
      ) : (
        <Card className="divide-y divide-border overflow-hidden">
          {profile.relationships.slice(0, 4).map((r) => <RelationshipLine key={r.id} r={r} from={name(r.from)} to={name(r.to)} />)}
        </Card>
      )}
    </DatasetSection>
  );
}

function RelationshipLine({ r, from, to }: { r: DatasetRelationship; from: string; to: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm">
      <RelationshipIcon className="size-4 shrink-0 text-hint" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{from} → {to}</span>
        <span className="block truncate text-muted-foreground">{r.label}</span>
      </span>
      {r.status === "suggested" ? <SuggestedBadge what="This link" /> : <Badge theme="success" size="xs">Confirmed</Badge>}
    </div>
  );
}

/** Curation in words (§4 "Recently changed"): the project's activity about this dataset, no hashes. */
function RecentlyChanged({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const feed = useQuery({ queryKey: [...projectKeys.activity(projectId), "first"], queryFn: () => fetchActivity(projectId), staleTime: 10_000 });
  const entries = (feed.data?.entries ?? []).filter((e) => e.link?.datasetId === datasetId || e.target === datasetId || e.target === `dataset:${datasetId}`).slice(0, 5);
  return (
    <DatasetSection id="changed-heading" title="Recently changed">
      {feed.isLoading ? (
        <Skeleton className="h-20 rounded-lg" />
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has changed since it was created.</p>
      ) : (
        <Card className="divide-y divide-border overflow-hidden" data-testid="dataset-recent">
          {entries.map((e) => {
            const who = e.who ?? actorOf(e.actor, e.onBehalfOf);
            const Icon = who.kind === "assistant" ? AiIcon : who.kind === "person" ? HumanIcon : ActivityIcon;
            return (
              <div key={e.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <Icon className={who.kind === "assistant" ? "size-4 shrink-0 text-ai-text" : "size-4 shrink-0 text-hint"} />
                <p className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{actorName(who)}</span> {e.label}
                </p>
                <time className="tnum shrink-0 text-muted-foreground" dateTime={e.at ?? undefined}>{relativeTime(e.at)}</time>
              </div>
            );
          })}
        </Card>
      )}
    </DatasetSection>
  );
}

/** One line (§4): the newest release and a way to compare, or that nothing is published yet. */
function LatestRelease({ projectId, datasetId, canEdit }: { projectId: string; datasetId: string; canEdit: boolean }) {
  const on = useQuery({ queryKey: ["versioning", datasetId, "enabled"], queryFn: () => versioningEnabled(datasetId), staleTime: Infinity });
  const releases = useQuery({ queryKey: ["versioning", datasetId, "releases"], queryFn: () => versioning.releases(datasetId, datasetId), enabled: !!on.data });
  const latest = releases.data?.items[0];
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-4 text-sm" data-testid="latest-release">
      <TagIcon className="size-4 text-hint" />
      {latest ? (
        <>
          <span>
            Published <span className="font-medium">{latest.tag}</span> <span className="text-muted-foreground">· {relativeTime(latest.created_at)}</span>
          </span>
          <Link to={datasetUrl(projectId, datasetId, "versions")} className="text-brand hover:underline">Compare changes</Link>
        </>
      ) : (
        <>
          <span className="text-muted-foreground">Not published yet. A release pins this dataset for training and audit.</span>
          {canEdit && (
            <Link to={datasetUrl(projectId, datasetId, "publish")} className="inline-flex items-center gap-1 text-brand hover:underline">
              Publish <ArrowRightIcon className="size-3.5" />
            </Link>
          )}
        </>
      )}
    </p>
  );
}
