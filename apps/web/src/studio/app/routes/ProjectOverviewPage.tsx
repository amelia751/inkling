import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AddDataIcon,
  AiIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  DatasetsIcon,
  ErrorIcon,
  ExploreIcon,
  FileIcon,
  LockIcon,
  MoreIcon,
  PrivacyIcon,
  RelationshipIcon,
  ReviewIcon,
  WarningIcon,
  type IconComponent,
} from "@studio/ui/icons";
import { AppLayout } from "@/studio/components/layout/app-layout";
import { DropOverlay, DropZone, useAddData, usePickers } from "@/studio/components/uploads/uploads";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { fetchAnnotations, fetchTaskDocument } from "@/studio/lib/api";
import { envLabel, envOf, projectIcon } from "@/studio/lib/environment";
import { kernelAssetUrl, kernelEnabled } from "@/extension-host/kernel";
import { seedUrl } from "@/studio/lib/api";
import { api, fetchPreview, fetchProposals, NeedsApiError, projectKeys, useOverview } from "@/studio/lib/projects-api";
import { kindIcon } from "@/studio/lib/file-kinds";
import { datasetUrl, exploreUrl, settingsUrl, sourcesUrl, studioUrl, targetUrl, taskSetupUrl } from "@/studio/lib/routes";
import { useShell } from "@/studio/stores/shell";
import { overviewContext, useAgentContext } from "@/studio/lib/agent/providers";
import type { AttentionItem, DataCard, ProjectOverview, ProjectSummary, Proposal, ResumeState } from "@studio/contracts/types";
import { NAMING } from "@studio/contracts/naming";
import { cn } from "@studio/ui/utils";

/**
 * Project Overview (todo6 Phase 3.3, docs/ux.md §4): where am I, what was I doing, what data is
 * here, what needs me. Every number comes from `GET /v1/projects/:id/overview`; while it loads,
 * skeletons in the cards' own shapes, never a 0.
 */
export function ProjectOverviewPage() {
  const { projectId = "" } = useParams();
  const overview = useOverview(projectId);
  // What the assistant sees here (todo6 Phase 6): the project summary.
  useAgentContext(useMemo(() => (overview.data ? overviewContext(overview.data) : null), [overview.data]));
  const addData = useAddData(projectId);
  const o = overview.data;

  return (
    <AppLayout>
      <DropOverlay label={o?.project.title ?? "this project"} onDrop={(p) => void addData(p)} className="min-h-full">
        <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6" data-testid="overview">
          {overview.error ? (
            <p className="text-sm text-muted-foreground">Couldn't open this project: {String(overview.error)}</p>
          ) : !o ? (
            <OverviewSkeleton />
          ) : (
            <>
              <ProjectHeader project={o.project} />
              {o.empty ? (
                <EmptyProject projectId={projectId} title={o.project.title} />
              ) : (
                <div className="flex flex-col gap-8">
                  <ImportResult overview={o} />
                  {o.resume ? <ResumeWorkCard projectId={projectId} resume={o.resume} /> : o.tasks.length > 0 && <StartCard projectId={projectId} tasks={o.tasks} />}
                  <SourceSummaryCards projectId={projectId} cards={o.data ?? []} onAdd={(p) => void addData(p)} />
                  <AttentionQueue projectId={projectId} items={o.attention ?? []} total={o.attentionTotal ?? 0} />
                </div>
              )}
            </>
          )}
        </div>
      </DropOverlay>
    </AppLayout>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy>
      <div>
        <SkeletonText variant="subheader" className="w-1/3" />
        <SkeletonText className="mt-2 w-1/2" />
      </div>
      <Skeleton className="h-[148px] rounded-xl" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[88px] rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-[120px] rounded-lg" />
    </div>
  );
}

// ---- Header ------------------------------------------------------------------------------------

/** Title and description edit in place; the `•••` menu has Settings, Rename and Archive. */
function ProjectHeader({ project }: { project: ProjectSummary }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<null | "title" | "description">(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: Partial<Pick<ProjectSummary, "title" | "description" | "archived">>) => api<ProjectSummary>(`/projects/${project.id}`, { method: "PATCH", json: patch }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: projectKeys.all }),
    onError: (e) => setError(e instanceof NeedsApiError ? "Editing projects needs the full stack: see docs/running.md" : String(e)),
  });
  return (
    <header className="mb-8" data-testid="project-header">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-sm text-hint">Project</p>
          {editing === "title" ? (
            <InlineEdit initial={project.title} label="Project name" onDone={(v) => (setEditing(null), v && v !== project.title && save.mutate({ title: v }))} className="text-header-2 font-semibold" />
          ) : (
            <h1 className="text-header-2 font-semibold">
              <button type="button" className="rounded-md text-left hover:bg-generic" onClick={() => setEditing("title")} title="Rename" data-testid="project-name">{project.title}</button>
            </h1>
          )}
          {editing === "description" ? (
            <InlineEdit initial={project.description} label="Description" multiline onDone={(v) => (setEditing(null), v !== null && v !== project.description && save.mutate({ description: v }))} className="mt-1 text-sm" />
          ) : (
            <button type="button" className="mt-1 max-w-2xl rounded-md text-left text-sm text-muted-foreground hover:bg-generic" onClick={() => setEditing("description")}>
              {project.description || <span className="text-hint">Add a short description</span>}
            </button>
          )}
          {error && <p className="mt-1 text-sm text-danger" role="alert">{error}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {project.sample && <Badge theme="info">Sample</Badge>}
          <Badge theme="unknown" data-testid="visibility">
            {project.visibility === "private" && <LockIcon />}
            {project.visibility === "private" ? "Private" : "Shared"}
          </Badge>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost-secondary" size="icon" aria-label="Project actions">
                <MoreIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => navigate(settingsUrl(project.id))}>Settings</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEditing("title")}>Rename</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={project.sample} onSelect={() => save.mutate({ archived: true }, { onSuccess: () => navigate("/projects") })}>Archive</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

function InlineEdit({ initial, label, multiline, onDone, className }: { initial: string; label: string; multiline?: boolean; onDone: (v: string | null) => void; className?: string }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.select(), []);
  const props = {
    ref,
    value: v,
    "aria-label": label,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setV(e.target.value),
    onBlur: () => onDone(v.trim()),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") onDone(null);
      if (e.key === "Enter" && (!multiline || !e.shiftKey)) {
        e.preventDefault();
        onDone(v.trim());
      }
    },
    className: cn("w-full max-w-2xl rounded-md border border-ring bg-background px-1 outline-none", className),
  };
  return multiline ? <textarea rows={2} {...props} /> : <input {...props} />;
}

// ---- Continue where you left off --------------------------------------------------------------

/** Only when there is resume state; opens the Studio on the same task, item, slice and tool. */
function ResumeWorkCard({ projectId, resume }: { projectId: string; resume: ResumeState }) {
  const doc = useQuery({ queryKey: ["tasks", resume.taskId, "document"], queryFn: () => fetchTaskDocument(resume.taskId), staleTime: 30_000 });
  const saved = useQuery({ queryKey: ["annotations", resume.taskId, "summary"], queryFn: () => fetchAnnotations(resume.taskId), staleTime: 10_000 });
  const project = doc.data;
  const env = project ? envOf(project) : undefined;
  const items = useMemo(() => (project && env ? env.dataKind.groupItems(project) : []), [project, env]);
  const item = items.find((i) => i.id === resume.itemId);
  const ids = new Set(items.map((i) => i.id));
  const done = saved.data ? new Set(saved.data.annotations.map((a) => a.itemId).filter((id) => ids.has(id))).size : null;
  const Icon = project ? projectIcon(project) : FileIcon;
  const asset = item?.assets[0] as ({ path: string; nodeId?: string } & Record<string, unknown>) | undefined;
  const preview = useQuery({ queryKey: ["source-nodes", asset?.nodeId, "preview"], queryFn: () => fetchPreview(asset!.nodeId!), enabled: !!asset?.nodeId, staleTime: 60_000 });
  const thumb = preview.data?.url ?? preview.data?.thumbnailUrl ?? (asset && /\.(png|jpe?g|webp)$/i.test(asset.path) ? (kernelEnabled() ? kernelAssetUrl(asset.path) : seedUrl(asset.path)) : null);

  return (
    <Card className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center" data-testid="resume-card">
      <div className="flex aspect-[4/3] w-full shrink-0 items-center justify-center overflow-hidden rounded-lg bg-canvas sm:w-44">
        {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" /> : <Icon className="size-10 text-canvas-foreground/60" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm text-ai-text">
          <AiIcon className="size-3.5" /> Continue where you left off
        </p>
        <h2 className="mt-1 truncate text-header-1 font-semibold">{resume.taskTitle}</h2>
        <p className="mt-0.5 truncate text-sm text-muted-foreground" data-testid="resume-item">
          {item?.name ?? (doc.isLoading ? "…" : "Last item")} · {env ? `${envLabel(env)} annotation` : resume.taskKind.replace("-", " ")}
        </p>
        <div className="mt-3 max-w-sm">
          {done === null || !items.length ? (
            <Skeleton className="h-4 w-40" />
          ) : (
            <>
              <p className="tnum text-sm" data-testid="resume-progress">{done} of {items.length} annotated</p>
              <div className="mt-1.5 h-1 overflow-hidden bg-generic-hover" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={items.length} aria-label="Items annotated">
                <div className={cn("h-full", done >= items.length ? "bg-positive" : "bg-primary")} style={{ width: `${Math.round((done / items.length) * 100)}%` }} />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 self-start sm:self-center">
        <Button variant="outline" size="lg" asChild>
          <Link to={taskSetupUrl(projectId, resume.taskId)} data-testid="task-setup-link">Task setup</Link>
        </Button>
        <Button size="lg" asChild>
          <Link to={studioUrl(projectId, resume.taskId)} state={{ resume: true }} data-testid="open-studio">
            Open Studio <ArrowRightIcon />
          </Link>
        </Button>
      </div>
    </Card>
  );
}

/** A task exists but nothing to resume: an encouraging start, never an empty progress bar. */
function StartCard({ projectId, tasks }: { projectId: string; tasks: { id: string }[] }) {
  return (
    <Card className="flex flex-wrap items-center gap-3 p-5" data-testid="start-card">
      <p className="min-w-0 flex-1 text-body-2">Pick up where the data is.</p>
      {tasks.length === 1 && (
        <Button variant="outline" size="lg" asChild>
          <Link to={taskSetupUrl(projectId, tasks[0].id)} data-testid="task-setup-link">Task setup</Link>
        </Button>
      )}
      <Button size="lg" asChild>
        <Link to={studioUrl(projectId)} data-testid="open-studio">Open Studio <ArrowRightIcon /></Link>
      </Button>
    </Card>
  );
}

// ---- What the latest import found -------------------------------------------------------------

/**
 * After inspection: a clean set offers its dataset proposal right here ("Create dataset & open
 * Studio · Review first"); a mixed one points to Explore ("See what we found").
 */
function ImportResult({ overview: o }: { overview: ProjectOverview }) {
  const projectId = o.project.id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const settled = o.latestImport && (o.latestImport.state === "ready" || o.latestImport.state === "needs_review");
  const proposals = useQuery({ queryKey: [...projectKeys.proposals(projectId), "proposed"], queryFn: () => fetchProposals(projectId, "proposed"), enabled: !!settled, staleTime: 5_000 });
  const confirm = useMutation({
    mutationFn: (p: Proposal) => api<{ task?: { id: string } }>(`/proposals/${p.id}/confirm`, { method: "POST", json: {} }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["projects", projectId] });
      // todo8 D7: the owner lands on Task setup, one click from the Studio.
      if (r.task) navigate(taskSetupUrl(projectId, r.task.id));
    },
  });
  if (!settled || !proposals.data?.length) return null;
  const dataset = proposals.data.find((p) => p.kind === "dataset");
  const others = proposals.data.filter((p) => p.kind !== "dataset");
  if (dataset && others.length === 0) {
    return (
      <Card className="flex flex-wrap items-center gap-4 border-dashed border-border-hover bg-utility-tint p-5" data-testid="import-proposal">
        <DatasetsIcon className="size-5 text-hint" />
        <p className="min-w-0 flex-1 text-body-2">{String(dataset.payload.summary ?? "This looks ready to annotate.")}</p>
        <Button variant="outline" size="lg" asChild>
          <Link to={exploreUrl(projectId, "summary", dataset.id)}>Review first</Link>
        </Button>
        <Button size="lg" loading={confirm.isPending} onClick={() => confirm.mutate(dataset)} data-testid="create-and-open">
          Create dataset & set up the task
        </Button>
      </Card>
    );
  }
  return (
    <Card className="flex flex-wrap items-center gap-4 border-dashed border-border-hover bg-utility-tint p-5" data-testid="import-explore">
      <ExploreIcon className="size-5 text-hint" />
      <p className="min-w-0 flex-1 text-body-2">Your files are in. Some of them need a decision before they become a dataset.</p>
      <Button size="lg" asChild>
        <Link to={exploreUrl(projectId)}>See what we found <ArrowRightIcon /></Link>
      </Button>
    </Card>
  );
}

// ---- Your data ---------------------------------------------------------------------------------

function SourceSummaryCards({ projectId, cards, onAdd }: { projectId: string; cards: DataCard[]; onAdd: (p: import("@/studio/lib/uploads/walk").Picked) => void }) {
  const { files, inputs } = usePickers(onAdd);
  return (
    <section aria-labelledby="data-heading">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id="data-heading" className="text-body-2 font-semibold">Your data</h2>
        <Link to={sourcesUrl(projectId)} className="text-sm text-brand hover:underline">View data</Link>
      </div>
      {inputs}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => {
          const Icon = kindIcon(c.kind);
          return (
            <Link key={c.id} to={c.type === "dataset" && c.datasetId ? datasetUrl(projectId, c.datasetId) : sourcesUrl(projectId, c.nodeId)} className="block rounded-lg" data-testid="data-card">
              <Card view="selection" className="flex h-full items-start gap-3 p-4">
                <Icon className="mt-0.5 size-5 shrink-0 text-hint" />
                <div className="min-w-0">
                  <p className="truncate font-medium" title={c.title}>{c.title}</p>
                  <p className="tnum truncate text-sm text-muted-foreground">{c.count.toLocaleString()} · {c.kindLabel}</p>
                </div>
              </Card>
            </Link>
          );
        })}
        <button type="button" onClick={files} className="flex min-h-[72px] items-center justify-center gap-2 rounded-lg border border-dashed border-border-hover text-sm text-muted-foreground hover:bg-generic hover:text-foreground" data-testid="add-data-card">
          <AddDataIcon className="size-4" /> Add data
        </button>
      </div>
    </section>
  );
}

// ---- Needs your attention ----------------------------------------------------------------------

const ATTENTION_ICON: Record<AttentionItem["type"], IconComponent> = {
  privacy: PrivacyIcon,
  import: ErrorIcon,
  quality: WarningIcon,
  proposal: RelationshipIcon,
  annotations: ReviewIcon,
  "version-review": ReviewIcon,
};

export function AttentionRow({ projectId, item }: { projectId: string; item: AttentionItem }) {
  const Icon = ATTENTION_ICON[item.type];
  return (
    <Link to={targetUrl(projectId, item.target)} className="flex items-center gap-3 px-4 py-3 hover:bg-generic" data-testid="attention-row" data-type={item.type}>
      <Icon className={cn("size-4 shrink-0", item.severity === "high" ? "text-warning" : "text-hint")} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{item.title}</p>
        {item.detail && <p className="truncate text-sm text-muted-foreground">{item.detail}</p>}
      </div>
      {item.strength && <span className="shrink-0 text-xs text-muted-foreground">{STRENGTH[item.strength]}</span>}
      <ChevronRightIcon className="size-4 shrink-0 text-hint" />
    </Link>
  );
}

export const STRENGTH = { strong: "Strong match", possible: "Possible match", weak: "Weak match" } as const;

function AttentionQueue({ projectId, items, total }: { projectId: string; items: AttentionItem[]; total: number }) {
  return (
    <section aria-labelledby="attention-heading">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id="attention-heading" className="text-body-2 font-semibold">Needs your attention</h2>
        {total > items.length && <Link to={`/projects/${projectId}/review`} className="text-sm text-brand hover:underline">All {total} in Review</Link>}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="all-caught-up">You're all caught up.</p>
      ) : (
        <Card className="divide-y divide-border overflow-hidden" data-testid="attention">
          {items.map((i) => (
            <AttentionRow key={i.id} projectId={projectId} item={i} />
          ))}
        </Card>
      )}
    </section>
  );
}

// ---- A brand-new project -----------------------------------------------------------------------

function EmptyProject({ projectId, title }: { projectId: string; title: string }) {
  const addData = useAddData(projectId);
  const setAssistant = useShell((s) => s.setAssistant);
  return (
    <div className="flex flex-col gap-4" data-testid="empty-project">
      <p className="text-body-3">Let's start with your data.</p>
      <DropZone onPick={(p) => void addData(p)} title={`Drop files or folders for ${title}`} hint="DICOM folders, images, videos, tables, documents. Originals are kept exactly as they are." className="py-14" />
      <button type="button" onClick={() => setAssistant(true, true)} className="self-start text-sm text-muted-foreground hover:text-foreground" data-testid="tell-assistant">
        <AiIcon className="mr-1.5 inline size-3.5 text-ai-text" />
        Or tell {NAMING.displayName} what you're trying to create…
      </button>
    </div>
  );
}

