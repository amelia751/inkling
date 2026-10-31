import { useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnnotateIcon, ChevronRightIcon, DatasetsIcon, FolderIcon, InfoIcon, PrivacyIcon } from "@studio/ui/icons";
import { AppLayout, NestedPage, PageHeading } from "@/studio/components/layout/app-layout";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Input } from "@studio/ui/ui/input";
import { Label } from "@studio/ui/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import type { DatasetSummary, SourceNode, TaskSummary } from "@studio/contracts/types";
import { registry } from "@/extension-host/registry";
import { createDataset, fetchChildren, fetchSources, NeedsApiError, projectKeys, useDataset, useDatasets } from "@/studio/lib/projects-api";
import { datasetUrl, exploreUrl, projectUrl, studioUrl } from "@/studio/lib/routes";
import { VersionsPage } from "@/studio/core/versioning";
import { ExportPage } from "./ExportPage";
import { FullPageMessage } from "./shared";

/**
 * Datasets (todo6 Phase 8, docs/ux.md §2): the datasets built from the project's sources, each
 * with its tasks and **Open Studio**. A dataset's page has Tasks · Versions · Publish & export.
 * **New dataset** without a proposal is a plain form (folders and a preset); the guided path,
 * where Inkling proposes the dataset, stays Explore.
 */
export function DatasetsPage() {
  const { projectId = "" } = useParams();
  const [params] = useSearchParams();
  const datasets = useDatasets(projectId);
  const [creating, setCreating] = useState(false);
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6" data-testid="datasets-page">
        <PageHeading
          title="Datasets"
          description="What you annotate: files picked from your data, with one or more tasks each."
          actions={
            <Button size="lg" onClick={() => setCreating(true)} data-testid="new-dataset">
              <DatasetsIcon /> New dataset
            </Button>
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
        {datasets.isLoading && (
          <div className="flex flex-col gap-3">
            {[0, 1].map((i) => <Skeleton key={i} className="h-32 rounded-lg" />)}
          </div>
        )}
        {datasets.error && <p className="text-sm text-muted-foreground">Couldn't load datasets: {String(datasets.error)}</p>}
        {datasets.data && datasets.data.length === 0 && (
          <Card className="p-6 text-sm text-muted-foreground" data-testid="no-datasets">
            No datasets yet. Pick folders with <button type="button" className="text-brand hover:underline" onClick={() => setCreating(true)}>New dataset</button>, or confirm one in{" "}
            <Link className="text-brand hover:underline" to={exploreUrl(projectId)}>Explore</Link>.
          </Card>
        )}
        <div className="flex flex-col gap-3">
          {datasets.data?.map((d) => <DatasetCard key={d.id} projectId={projectId} dataset={d} />)}
        </div>
      </div>
      {creating && <NewDatasetDialog projectId={projectId} onClose={() => setCreating(false)} />}
    </AppLayout>
  );
}

function DatasetCard({ projectId, dataset: d }: { projectId: string; dataset: DatasetSummary }) {
  const held = Array.isArray(d.definition.heldNodeIds) ? d.definition.heldNodeIds.length : 0;
  return (
    <Card className="overflow-hidden" data-testid="dataset-card" data-dataset-id={d.id}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <Link to={datasetUrl(projectId, d.id)} className="text-body-2 font-semibold hover:underline" data-testid="dataset-link">
            {d.title}
          </Link>
          <p className="mt-0.5 text-sm text-muted-foreground">
            <span className="tnum">{d.fileCount}</span> {d.fileCount === 1 ? "file" : "files"}
            {d.description && <> · {d.description}</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {d.definition.seed && <Badge theme="unknown" size="xs">Sample</Badge>}
          {held > 0 && (
            <Badge theme="warning" size="xs">
              <PrivacyIcon /> {held} held for privacy
            </Badge>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link to={datasetUrl(projectId, d.id, "versions")}>Versions</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to={datasetUrl(projectId, d.id, "publish")}>Publish & export</Link>
          </Button>
        </div>
      </div>
      <TaskList projectId={projectId} tasks={d.tasks} />
    </Card>
  );
}

function TaskList({ projectId, tasks }: { projectId: string; tasks: TaskSummary[] }) {
  if (!tasks.length) return <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">No tasks yet.</p>;
  return (
    <ul className="divide-y divide-border border-t border-border">
      {tasks.map((t) => (
        <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm" data-testid="task-row" data-task-id={t.id}>
          <AnnotateIcon className="size-4 shrink-0 text-hint" />
          <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
          <span className="hidden capitalize text-muted-foreground sm:inline">{t.kind.replace(/-/g, " ")}</span>
          <span className="tnum text-muted-foreground">
            {t.annotationCount} {t.annotationCount === 1 ? "annotation" : "annotations"}
          </span>
          <Button size="sm" asChild>
            <Link to={studioUrl(projectId, t.id)} data-testid="open-studio">Open Studio</Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}

// ---- Dataset detail ---------------------------------------------------------------------------

type DatasetTab = "tasks" | "versions" | "publish";

/** `/projects/:p/datasets/:d` (+ `/versions`, `/publish`): the dataset's tabs, one shell. */
export function DatasetDetailPage({ tab }: { tab: DatasetTab }) {
  const { projectId = "", datasetId = "" } = useParams();
  const ds = useDataset(projectId, datasetId);
  const [exportTask, setExportTask] = useState<string | null>(null);
  if (ds.error) return <AppLayout><FullPageMessage title="Dataset not found" body={String(ds.error)} /></AppLayout>;
  const d = ds.data;
  const tasks = d?.tasks ?? [];
  const taskForExport = exportTask ?? tasks[0]?.id;
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6" data-testid="dataset-detail" data-tab={tab}>
        <nav className="mb-2 flex items-center gap-1 text-sm text-muted-foreground" aria-label="Breadcrumb">
          <Link to={projectUrl(projectId, "datasets")} className="hover:text-foreground">Datasets</Link>
          <ChevronRightIcon className="size-3.5 text-hint" />
          <span className="truncate text-foreground">{d?.title ?? <Skeleton className="inline-block h-4 w-32 align-middle" />}</span>
        </nav>
        <nav className="mb-5 flex items-end gap-6 overflow-x-auto shadow-[inset_0_-1px_0_0_var(--g-line)] hide-scrollbar" aria-label="Dataset sections">
          <TabLink to={datasetUrl(projectId, datasetId)} end>Tasks</TabLink>
          <TabLink to={datasetUrl(projectId, datasetId, "versions")}>Versions</TabLink>
          <TabLink to={datasetUrl(projectId, datasetId, "publish")}>Publish & export</TabLink>
        </nav>
        {tab === "tasks" &&
          (d ? (
            <Card className="overflow-hidden" data-testid="dataset-tasks">
              <div className="px-4 py-3">
                <h2 className="text-body-2 font-semibold">Tasks</h2>
                <p className="text-sm text-muted-foreground">
                  <span className="tnum">{d.fileCount}</span> {d.fileCount === 1 ? "file" : "files"}
                  {d.description && <> · {d.description}</>}
                </p>
              </div>
              <TaskList projectId={projectId} tasks={tasks} />
            </Card>
          ) : (
            <Skeleton className="h-32 rounded-lg" />
          ))}
        {tab === "versions" && (
          <NestedPage>
            <VersionsPage />
          </NestedPage>
        )}
        {tab === "publish" &&
          (d ? (
            tasks.length ? (
              <>
                {tasks.length > 1 && (
                  <div className="mb-4 flex items-center gap-3">
                    <Label htmlFor="export-task" className="text-sm">Task</Label>
                    <Select value={taskForExport} onValueChange={setExportTask}>
                      <SelectTrigger id="export-task" className="w-64"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {tasks.map((t) => <SelectItem key={t.id} value={t.id}>{t.title}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <NestedPage>
                  <ExportPage key={taskForExport} taskId={taskForExport} />
                </NestedPage>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing to export yet: this dataset has no task.</p>
            )
          ) : (
            <Skeleton className="h-48 rounded-lg" />
          ))}
      </div>
    </AppLayout>
  );
}

function TabLink({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn("flex h-9 shrink-0 items-center whitespace-nowrap border-b-2 pt-0.5 text-sm transition-colors hover:text-foreground", isActive ? "border-brand text-foreground" : "border-transparent text-muted-foreground")
      }
    >
      {children}
    </NavLink>
  );
}

// ---- New dataset (the simple form) -----------------------------------------------------------

interface Crumb {
  id: string | null;
  name: string;
}

/**
 * Name, folders and a preset. Folders are picked in a flat list with a breadcrumb (Finder's
 * column-less list view): click a name to open it, tick it to include all of it.
 */
function NewDatasetDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sources = useQuery({ queryKey: projectKeys.sources(projectId), queryFn: () => fetchSources(projectId) });
  const presets = useMemo(() => registry.list("presets").map((p) => ({ value: `preset:${p.name}`, title: p.title, description: p.description })), []);
  const [title, setTitle] = useState("");
  const [taskTitle, setTaskTitle] = useState("Annotate");
  const [preset, setPreset] = useState<string>("");
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [trail, setTrail] = useState<Crumb[]>([]);
  const source = sources.data?.find((s) => s.id === (sourceId ?? sources.data?.[0]?.id));
  const here = trail.at(-1)?.id ?? null;
  const children = useQuery({ queryKey: projectKeys.children(source?.id ?? "", here), queryFn: () => fetchChildren(source!.id, here), enabled: !!source });
  const create = useMutation({
    mutationFn: () => createDataset(projectId, { title: title.trim(), nodeIds: [...picked.keys()], task: { title: taskTitle.trim() || "Annotate", ...(preset ? { preset } : {}) } }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: projectKeys.datasets(projectId) });
      void qc.invalidateQueries({ queryKey: projectKeys.overview(projectId) });
      onClose();
      navigate(datasetUrl(projectId, d.id));
    },
  });
  const toggle = (id: string, name: string) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(id)) next.delete(id);
      else next.set(id, name);
      return next;
    });
  const label = (n: SourceNode) => n.displayPath ?? n.name;
  const rows = (children.data?.items ?? []).filter((n) => n.kind !== "sequence");
  const canCreate = !!title.trim() && picked.size > 0 && !create.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="new-dataset-dialog">
        <DialogHeader>
          <DialogTitle>New dataset</DialogTitle>
          <DialogDescription>Pick the folders to annotate and how the Studio should open them. Originals are never changed.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="dataset-title">Name</Label>
            <Input id="dataset-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chest X-rays, first batch" autoFocus />
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Folders</span>
            {sources.data && sources.data.length > 1 && (
              <Select value={source?.id} onValueChange={(v) => { setSourceId(v); setTrail([]); }}>
                <SelectTrigger aria-label="Source" className="w-64"><SelectValue /></SelectTrigger>
                <SelectContent>{sources.data.map((s) => <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <div className="rounded-md border border-border">
              <nav className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-sm" aria-label="Folder path" data-testid="folder-breadcrumb">
                <button type="button" className={cn("hover:underline", trail.length ? "text-muted-foreground" : "font-medium")} onClick={() => setTrail([])}>
                  {source?.title ?? "Data"}
                </button>
                {trail.map((c, i) => (
                  <span key={c.id ?? i} className="flex items-center gap-1">
                    <ChevronRightIcon className="size-3.5 text-hint" />
                    <button type="button" className={cn("hover:underline", i === trail.length - 1 ? "font-medium" : "text-muted-foreground")} onClick={() => setTrail(trail.slice(0, i + 1))}>
                      {c.name}
                    </button>
                  </span>
                ))}
              </nav>
              <ul className="thin-scrollbar max-h-64 overflow-y-auto" data-testid="folder-list">
                {(sources.isLoading || children.isLoading) && <li className="px-3 py-2"><Skeleton className="h-5 w-48" /></li>}
                {sources.data?.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No sources yet. Add data first.</li>}
                {source && (
                  <li className="flex h-9 items-center gap-2 border-b border-border px-3 text-sm">
                    <Checkbox
                      id="pick-here"
                      checked={picked.has(here ?? source.rootNodeId ?? "")}
                      onCheckedChange={() => {
                        const id = here ?? source.rootNodeId;
                        if (id) toggle(id, trail.at(-1)?.name ?? source.title);
                      }}
                    />
                    <Label htmlFor="pick-here" className="font-normal text-muted-foreground">Everything in {trail.at(-1)?.name ?? source.title}</Label>
                  </li>
                )}
                {rows.map((n) => (
                  <li key={n.id} className="flex h-9 items-center gap-2 px-3 text-sm hover:bg-generic" data-testid="folder-row">
                    <Checkbox checked={picked.has(n.id)} onCheckedChange={() => toggle(n.id, label(n))} aria-label={`Include ${label(n)}`} />
                    {n.kind === "folder" ? (
                      <button type="button" data-testid="open-folder" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setTrail([...trail, { id: n.id, name: label(n) }])}>
                        <FolderIcon className="size-4 shrink-0 text-hint" />
                        <span className="truncate">{label(n)}</span>
                        <span className="tnum ml-auto shrink-0 text-muted-foreground">{n.descendantCount} files</span>
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{n.name}</span>
                    )}
                  </li>
                ))}
                {children.data && !rows.length && <li className="px-3 py-3 text-sm text-muted-foreground">This folder is empty.</li>}
              </ul>
            </div>
            <p className="text-sm text-muted-foreground" data-testid="picked-summary">
              {picked.size ? `${picked.size} picked: ${[...picked.values()].slice(0, 3).join(", ")}${picked.size > 3 ? "…" : ""}` : "Nothing picked yet."}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="dataset-preset">Studio setup</Label>
              <Select value={preset} onValueChange={setPreset}>
                <SelectTrigger id="dataset-preset" data-testid="preset-picker"><SelectValue placeholder="Choose later" /></SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.value} value={p.value} title={p.description}>{p.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-title">First task</Label>
              <Input id="task-title" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
            </div>
          </div>
          {create.error && (
            <p className="rounded-md bg-danger-tint px-3 py-2 text-sm text-danger" role="alert">
              {create.error instanceof NeedsApiError ? "Creating datasets needs the full stack: see docs/running.md" : String(create.error.message)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!canCreate} data-testid="create-dataset">Create dataset</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
