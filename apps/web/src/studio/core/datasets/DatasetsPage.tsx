import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { DatasetSummary } from "@studio/contracts/types";
import { AiIcon, ArrowRightIcon, DatasetsIcon, GridViewIcon, InfoIcon, ListViewIcon, PrivacyIcon, SearchIcon, SourcesIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { NoResults } from "@studio/ui/ui/empty-state";
import { Input } from "@studio/ui/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { ErrorView } from "@/studio/app/routes/errors";
import { relativeTime } from "@/studio/components/files";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { kindIcon } from "@/studio/lib/file-kinds";
import { useDatasets, useOverview, useProjectSummary, useReviewQueue } from "@/studio/lib/projects-api";
import { canEditTaskSetup } from "@/studio/lib/task-setup";
import { datasetUrl, exploreUrl, projectUrl, sourcesUrl, studioUrl, targetUrl } from "@/studio/lib/routes";
import { useDatasetAttention, useDatasetProfiles, useDatasetSummaries, usePipelineProblems, type DatasetLandingSummary } from "./api";
import { readRecentDatasets, useAddData } from "./add-data";
import { attentionFromQueue, contentSummary, countOf, datasetStatus, MODALITIES, modalitiesOf, pipelineAttention, rankAttention, STATUS_LABEL, STATUS_THEME, summaryFromProfile, type DatasetStatus, type Modality } from "./model";
import { AttentionLine } from "./shared";
import { TaskList } from "./DatasetOverview";
import { NewDatasetDialog } from "./NewDatasetDialog";
import { DatasetsEmptyState } from "@/studio/app/entry/empty-states";
import { RenameInPlace, ResourceMenu } from "@/studio/components/trash/delete-dialog";

type View = "cards" | "list";

/**
 * Datasets (docs/datasets.md §2.1): where people organize, understand and prepare their data.
 * Above the fold, the work: what to continue, what needs attention, then the datasets with what
 * they hold, counted at a stated level. Never only a table, never vanity numbers.
 */
export function DatasetsPage() {
  const { projectId = "" } = useParams();
  const [params] = useSearchParams();
  const datasets = useDatasets(projectId);
  const list = useMemo(() => datasets.data ?? [], [datasets.data]);
  const canEdit = canEditTaskSetup(useProjectSummary(projectId).data);
  const addData = useAddData(projectId);
  // One request for every card; a server without it (null) falls back to a profile per dataset.
  const summaries = useDatasetSummaries(projectId);
  const fallback = summaries.data === null || !!summaries.error;
  const profiles = useDatasetProfiles(projectId, fallback ? list.map((d) => d.id) : [], fallback);
  const profileOf = (id: string): DatasetLandingSummary | undefined => {
    if (!fallback) return summaries.data?.datasets.find((s) => s.datasetId === id);
    const p = profiles[list.findIndex((d) => d.id === id)]?.data;
    return p && summaryFromProfile(id, p);
  };
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const [modality, setModality] = useState<Modality | "">("");
  const [status, setStatus] = useState<DatasetStatus | "">("");
  const [view, setView] = useState<View>("cards");
  const needle = q.trim().toLowerCase();
  const shown = list.filter((d) => {
    const p = profileOf(d.id);
    if (needle && !`${d.title} ${d.description}`.toLowerCase().includes(needle)) return false;
    if (modality && !modalitiesOf(p).includes(modality)) return false;
    if (status && datasetStatus(d, p) !== status) return false;
    return true;
  });
  const filtered = !!(needle || modality || status);
  const clear = () => (setQ(""), setModality(""), setStatus(""));

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6" data-testid="datasets-page">
        <PageHeading
          title="Datasets"
          description="Organize, understand, and prepare your data."
          actions={
            <>
              <Button variant="outline" size="lg" asChild>
                <Link to={sourcesUrl(projectId)} data-testid="add-from-sources"><SourcesIcon /> Add from sources</Link>
              </Button>
              {canEdit && (
                <Button size="lg" onClick={() => setCreating(true)} data-testid="new-dataset">
                  <DatasetsIcon /> Create dataset
                </Button>
              )}
            </>
          }
        />
        {params.get("hint") === "no-task" && (
          <p className="mb-4 flex items-start gap-2 rounded-md bg-info-tint px-3 py-2 text-sm" data-testid="no-task-hint">
            <InfoIcon className="mt-px size-4 shrink-0 text-info" />
            <span>
              The Studio opens a task, and this project has none yet. Create a dataset here, or let {""}
              <Link className="underline" to={exploreUrl(projectId)}>Explore</Link> propose one from what it found.
            </span>
          </p>
        )}
        {datasets.error ? (
          <ErrorView variant="section" error={datasets.error} what="datasets" onRetry={() => void datasets.refetch()} />
        ) : datasets.isLoading ? (
          <LandingSkeleton />
        ) : list.length === 0 ? (
          <DatasetsEmpty projectId={projectId} canEdit={canEdit} onCreate={() => setCreating(true)} onAdd={addData} />
        ) : (
          <div className="flex flex-col gap-8">
            <ContinueWorking projectId={projectId} datasets={list} />
            <NeedsAttention projectId={projectId} />
            <section aria-labelledby="your-datasets">
              <h2 id="your-datasets" className="mb-3 text-body-2 font-semibold">Your datasets</h2>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <div className="relative min-w-[220px] flex-1">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-hint" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search datasets" className="pl-8" aria-label="Search datasets" data-testid="datasets-search" />
                </div>
                <Select value={modality || "all"} onValueChange={(v) => setModality(v === "all" ? "" : (v as Modality))}>
                  <SelectTrigger className="w-40" aria-label="Modality" data-testid="filter-modality"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any modality</SelectItem>
                    {MODALITIES.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : (v as DatasetStatus))}>
                  <SelectTrigger className="w-40" aria-label="Status" data-testid="filter-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any status</SelectItem>
                    {(Object.keys(STATUS_LABEL) as DatasetStatus[]).map((s) => <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>)}
                  </SelectContent>
                </Select>
                <SegmentedControl
                  value={view}
                  onValueChange={setView}
                  size="md"
                  options={[
                    { value: "cards", label: <GridViewIcon />, "aria-label": "Cards", title: "Cards" },
                    { value: "list", label: <ListViewIcon />, "aria-label": "List", title: "List" },
                  ]}
                  aria-label="View"
                />
              </div>
              {shown.length === 0 ? (
                <NoResults what="datasets" onClear={filtered ? clear : undefined} />
              ) : view === "cards" ? (
                <div className="grid gap-4 md:grid-cols-2" data-view="cards">
                  {shown.map((d) => <DatasetCard key={d.id} projectId={projectId} dataset={d} profile={profileOf(d.id)} canEdit={canEdit} />)}
                </div>
              ) : (
                <Card className="divide-y divide-border overflow-hidden" data-view="list">
                  {shown.map((d) => <DatasetRow key={d.id} projectId={projectId} dataset={d} profile={profileOf(d.id)} />)}
                </Card>
              )}
            </section>
          </div>
        )}
      </div>
      {creating && <NewDatasetDialog projectId={projectId} onClose={() => setCreating(false)} />}
    </AppLayout>
  );
}

function LandingSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2" aria-busy data-testid="datasets-loading">
      {[0, 1].map((i) => <Skeleton key={i} className="h-48 rounded-lg" />)}
    </div>
  );
}

/**
 * No datasets yet (todo13 §3.1): what will appear here and the composer's two actions, not a
 * link to another page. `no-datasets` is the old test id, kept working beside `datasets-empty`.
 */
function DatasetsEmpty({ projectId, canEdit, onCreate }: { projectId: string; canEdit: boolean; onCreate: () => void; onAdd?: (intent: "drop" | "ask") => void }) {
  // todo13 §3.1: the one composer empty state (drop files, ask), Create dataset beside it.
  return (
    <div data-testid="no-datasets">
      <DatasetsEmptyState
        projectId={projectId}
        actions={
          canEdit ? (
            <Button variant="outline" size="lg" onClick={onCreate} data-testid="datasets-empty-create">
              Create dataset
            </Button>
          ) : (
            <span className="text-caption text-hint" data-testid="datasets-empty-viewer">You can view this project. Ask a contributor to add files.</span>
          )
        }
      />
    </div>
  );
}

/**
 * Where someone was working (§2.1 "Continue working"): the Studio they left, then the datasets
 * this person opened last, each with its most relevant next step.
 */
function ContinueWorking({ projectId, datasets }: { projectId: string; datasets: DatasetSummary[] }) {
  const overview = useOverview(projectId);
  const attention = useDatasetAttention(projectId);
  const resume = overview.data?.resume;
  const d = resume && datasets.find((x) => x.id === resume.datasetId);
  const recent = useMemo(() => readRecentDatasets(projectId), [projectId]);
  const opened = recent
    .map((r) => ({ ...r, d: datasets.find((x) => x.id === r.id) }))
    .filter((r): r is { id: string; at: number; d: DatasetSummary } => !!r.d && r.id !== d?.id)
    .slice(0, d ? 2 : 3);
  if (!(resume && d) && !opened.length) return null;
  const next = (id: string) => rankAttention((attention.data?.items ?? []).filter((i) => i.datasetId === id))[0];
  return (
    <section aria-labelledby="continue-datasets">
      <h2 id="continue-datasets" className="mb-3 text-body-2 font-semibold">Continue working</h2>
      <div className="flex flex-col gap-3">
        {resume && d && (
          <Card className="flex flex-wrap items-center gap-4 p-4" data-testid="datasets-continue">
            <AiIcon className="size-4 shrink-0 text-ai-text" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{resume.taskTitle}</p>
              <p className="truncate text-sm text-muted-foreground">
                In {d.title}
                {resume.at && <> · {relativeTime(resume.at)}</>}
              </p>
            </div>
            <Button variant="outline" size="lg" asChild>
              <Link to={datasetUrl(projectId, d.id)}>Open dataset</Link>
            </Button>
            <Button size="lg" asChild>
              <Link to={studioUrl(projectId, resume.taskId)} state={{ resume: true }}>Open Studio <ArrowRightIcon /></Link>
            </Button>
          </Card>
        )}
        {opened.length > 0 && (
          <Card className="divide-y divide-border overflow-hidden" data-testid="datasets-recent">
            {opened.map((r) => {
              const step = next(r.id);
              return (
                <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-testid="recent-dataset" data-dataset-id={r.id}>
                  <DatasetsIcon className="size-4 shrink-0 text-hint" />
                  <span className="min-w-0 flex-1">
                    <Link to={datasetUrl(projectId, r.id)} className="block truncate font-medium hover:underline">{r.d.title}</Link>
                    <span className="block truncate text-muted-foreground">Opened {relativeTime(new Date(r.at).toISOString())}{step && <> · {step.title}</>}</span>
                  </span>
                  {step && (
                    <Button variant="outline" size="sm" asChild>
                      <Link to={targetUrl(projectId, step.action.target)}>{step.action.label}</Link>
                    </Button>
                  )}
                </div>
              );
            })}
          </Card>
        )}
      </div>
    </section>
  );
}

const ATTENTION_SHOWN = 5;

/**
 * §2.1 "Needs attention" across the project's datasets: malformed files, unconfirmed
 * suggestions, drop plans waiting for a decision and pipeline runs that need a person,
 * riskiest first. A server without the attention read falls back to the review queue's rows.
 */
function NeedsAttention({ projectId }: { projectId: string }) {
  const attention = useDatasetAttention(projectId);
  const queue = useReviewQueue(projectId);
  const pipeline = usePipelineProblems(projectId);
  const base = attention.data === null ? attentionFromQueue(queue.data?.items ?? []) : (attention.data?.items ?? []);
  const items = rankAttention([...base, ...pipelineAttention(pipeline.data)]);
  if (attention.isLoading) return <Skeleton className="h-24 rounded-lg" />;
  if (attention.error) return <ErrorView variant="section" error={attention.error} what="what needs attention" onRetry={() => void attention.refetch()} />;
  if (!items.length) return null;
  const total = (attention.data?.total ?? base.length) + (items.length - base.length);
  return (
    <section aria-labelledby="datasets-attention">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id="datasets-attention" className="text-body-2 font-semibold">Needs attention</h2>
        {total > ATTENTION_SHOWN && <Link to={projectUrl(projectId, "review")} className="text-sm text-brand hover:underline">{total - ATTENTION_SHOWN} more in Review</Link>}
      </div>
      <Card className="divide-y divide-border overflow-hidden" data-testid="datasets-attention">
        {items.slice(0, ATTENTION_SHOWN).map((i) => <AttentionLine key={i.id} projectId={projectId} item={i} showDataset />)}
      </Card>
    </section>
  );
}

function ModalityIcons({ profile }: { profile: DatasetLandingSummary }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-hint" aria-hidden>
      {profile.collections.slice(0, 4).map((c) => {
        const Icon = kindIcon(c.kind);
        return <Icon key={c.id} className="size-4" />;
      })}
    </span>
  );
}

function StatusBadge({ dataset, profile }: { dataset: DatasetSummary; profile?: DatasetLandingSummary }) {
  const s = datasetStatus(dataset, profile);
  return s ? <Badge theme={STATUS_THEME[s]} size="xs" data-testid="dataset-status">{STATUS_LABEL[s]}</Badge> : null;
}

/** §2.1's card: name, purpose, modalities, content at a stated level, structure, freshness. */
function DatasetCard({ projectId, dataset: d, profile: p, canEdit = false }: { projectId: string; dataset: DatasetSummary; profile?: DatasetLandingSummary; canEdit?: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const held = Array.isArray(d.definition.heldNodeIds) ? d.definition.heldNodeIds.length : 0;
  const changed = p?.lastChangedAt ?? d.createdAt;
  return (
    <Card className="flex flex-col overflow-hidden" data-testid="dataset-card" data-dataset-id={d.id}>
      <div className="flex flex-1 flex-col gap-1 px-4 pb-3 pt-4">
        <div className="flex items-start gap-2">
          <RenameInPlace projectId={projectId} kind="dataset" id={d.id} name={d.title} editing={renaming} onEditingChange={setRenaming} className="flex min-w-0 flex-1 items-center gap-1">
            <Link to={datasetUrl(projectId, d.id)} className="min-w-0 flex-1 truncate text-body-2 font-semibold hover:underline" data-testid="dataset-link">
              {d.title}
            </Link>
          </RenameInPlace>
          {d.definition.seed && <Badge theme="unknown" size="xs">Sample</Badge>}
          <StatusBadge dataset={d} profile={p} />
          <ResourceMenu projectId={projectId} kind="dataset" id={d.id} name={d.title} canEdit={canEdit && !d.definition.seed} onRename={() => setRenaming(true)} />
        </div>
        {d.description && <p className="line-clamp-2 text-sm text-muted-foreground">{d.description}</p>}
        {p ? (
          <>
            <p className="mt-1 flex items-center gap-2 text-sm">
              <ModalityIcons profile={p} />
              <span className="truncate">{p.collections.map((c) => c.name).join(" · ") || "No files yet"}</span>
            </p>
            {p.collections.length > 0 && <p className="tnum text-sm text-muted-foreground" data-testid="dataset-content">{contentSummary(p)}</p>}
            <p className="text-sm text-muted-foreground" data-testid="dataset-structure-line">
              Structure: {countOf(p.collections.length + p.moreCollections, { one: "collection", other: "collections" })} · {countOf(p.relationships, { one: "connection", other: "connections" })}
              {p.suggestions > 0 && <> · {countOf(p.suggestions, { one: "suggestion", other: "suggestions" })} to confirm</>}
            </p>
            <p className="text-sm">
              {p.issues.items > 0 ? <span className="text-warning">{countOf(p.issues.items, { one: "item needs attention", other: "items need attention" })}</span> : <span className="text-muted-foreground">No problems found</span>}
              {p.checking > 0 && <span className="text-muted-foreground"> · {countOf(p.checking, { one: "file", other: "files" })} processing</span>}
              {changed && <span className="text-muted-foreground"> · {p.lastChangedAt ? "Changed" : "Created"} {relativeTime(changed)}</span>}
            </p>
          </>
        ) : (
          <div className="mt-1 space-y-1.5">
            <SkeletonText className="w-2/3" />
            <SkeletonText className="w-1/2" />
          </div>
        )}
        {held > 0 && (
          <Badge theme="warning" size="xs" className="mt-1 self-start">
            <PrivacyIcon /> {held} held for privacy
          </Badge>
        )}
      </div>
      {d.tasks.length > 0 && (
        <div className="border-t border-border">
          <TaskList projectId={projectId} tasks={d.tasks} canEdit={canEdit} />
        </div>
      )}
      <div className="flex justify-end border-t border-border px-4 py-2.5">
        <Button variant="outline" size="sm" asChild>
          <Link to={datasetUrl(projectId, d.id)} data-testid="open-dataset">Open dataset</Link>
        </Button>
      </div>
    </Card>
  );
}

/** The comfortable list view: one row per dataset, the same facts in a line. */
function DatasetRow({ projectId, dataset: d, profile: p }: { projectId: string; dataset: DatasetSummary; profile?: DatasetLandingSummary }) {
  return (
    <Link to={datasetUrl(projectId, d.id)} className={cn("flex items-center gap-4 px-4 py-3 text-sm hover:bg-generic")} data-testid="dataset-row" data-dataset-id={d.id}>
      {p ? <ModalityIcons profile={p} /> : <Skeleton className="size-4" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{d.title}</span>
        <span className="tnum block truncate text-muted-foreground">{p ? contentSummary(p) || "No files yet" : "…"}</span>
      </span>
      <StatusBadge dataset={d} profile={p} />
      <span className="hidden shrink-0 text-muted-foreground md:inline">{d.createdAt ? relativeTime(d.createdAt) : ""}</span>
    </Link>
  );
}
