import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { DatasetProfile, DatasetSummary } from "@studio/contracts/types";
import { AddDataIcon, AiIcon, BranchIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, ExportIcon, TagIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Label } from "@studio/ui/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { AppLayout, NestedPage } from "@/studio/components/layout/app-layout";
import { FollowedFoldersBanner, NewerVersionsBanner } from "@/studio/components/files";
import { fetchUpdateVersionsPreview, useAddFollowed, useUpdateVersions } from "@/studio/lib/files/api";
import { notify } from "@/studio/lib/files/announce";
import { NeedsApiError, useDataset, useProjectSummary } from "@/studio/lib/projects-api";
import { datasetUrl, projectUrl, type DatasetTab } from "@/studio/lib/routes";
import { useAgentContext } from "@/studio/lib/agent/providers";
import { canEditTaskSetup } from "@/studio/lib/task-setup";
import { useShell } from "@/studio/stores/shell";
import { api as versioning } from "@/studio/core/versioning/api";
import { versioningEnabled } from "@/studio/core/versioning/session";
import { ErrorView } from "@/studio/app/routes/errors";
import { ExportPage } from "@/studio/app/routes/ExportPage";
import { useDatasetView, type ProfileQuery } from "./api";
import { datasetContext, rememberDataset, useAddData } from "./add-data";
import type { DatasetStructure as StructureDraft } from "./structure";
import { ReadOnlyBadge } from "./shared";
import { RenameInPlace, ResourceMenu } from "@/studio/components/trash/delete-dialog";
import { datasetStatus, STATUS_LABEL, STATUS_THEME } from "./model";
import { DatasetOverview } from "./DatasetOverview";
import { DatasetStructure } from "./structure/DatasetStructure";
import { FieldsAndFormats } from "./formats/FieldsAndFormats";
import { AnnotationDefinitions } from "./annotations/AnnotationDefinitions";
import { DatasetQuality } from "./quality/DatasetQuality";
import { DatasetHistory } from "./history/DatasetHistory";

/** The secondary navigation (docs/datasets.md §2.2). History is one view of six, not the page. */
const TABS: { tab: Exclude<DatasetTab, "publish">; label: string }[] = [
  { tab: "overview", label: "Overview" },
  { tab: "structure", label: "Structure" },
  { tab: "fields", label: "Fields & Formats" },
  { tab: "annotations", label: "Annotations" },
  { tab: "quality", label: "Quality" },
  { tab: "versions", label: "History" },
];

export interface DatasetViewProps {
  projectId: string;
  dataset: DatasetSummary;
  /** The working draft's profile, as its structure describes it (`useDatasetView`). */
  profile: ProfileQuery;
  /** The stored structure draft: `null` when the dataset has none yet (or the server can't store one). */
  structure?: StructureDraft | null;
  /** Contributors propose changes and publish; viewers browse (§12.2). */
  canEdit: boolean;
}

/** `/projects/:p/datasets/:d[/structure|/fields|/annotations|/quality|/versions|/publish]`. */
export function DatasetLayout({ tab }: { tab: DatasetTab }) {
  const { projectId = "", datasetId = "" } = useParams();
  const ds = useDataset(projectId, datasetId);
  const { structure, ...profile } = useDatasetView(projectId, datasetId);
  const summary = useProjectSummary(projectId);
  const canEdit = canEditTaskSetup(summary.data);
  const d = ds.data;
  // The assistant works on this dataset while it's open (a drop from here lands in it).
  useAgentContext(useMemo(() => (d ? datasetContext(projectId, d, profile.data) : null), [projectId, d, profile.data]));
  useEffect(() => {
    if (d) rememberDataset(projectId, d.id);
  }, [projectId, d]);
  if (ds.error)
    return (
      <AppLayout>
        <ErrorView error={ds.error} what="dataset" onRetry={() => void ds.refetch()} />
      </AppLayout>
    );
  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6" data-testid="dataset-detail" data-tab={tab}>
        <nav className="mb-2 flex items-center gap-1 text-sm text-muted-foreground" aria-label="Breadcrumb">
          <Link to={projectUrl(projectId, "datasets")} className="hover:text-foreground">Datasets</Link>
          <ChevronRightIcon className="size-3.5 text-hint" />
          <span className="truncate text-foreground">{d?.title ?? <Skeleton className="inline-block h-4 w-32 align-middle" />}</span>
        </nav>
        <DatasetHeader projectId={projectId} dataset={d} profile={profile.data} canEdit={canEdit} />
        <nav className="mb-5 flex items-end gap-6 overflow-x-auto shadow-[inset_0_-1px_0_0_var(--g-line)] hide-scrollbar" aria-label="Dataset sections" data-testid="dataset-tabs">
          {TABS.map((t) => (
            <TabLink key={t.tab} to={datasetUrl(projectId, datasetId, t.tab)} end={t.tab === "overview"}>
              {t.label}
              {t.tab === "quality" && !!profile.data?.issues.length && (
                <span data-counter className="tnum">{profile.data.issues.reduce((n, i) => n + i.count, 0).toLocaleString()}</span>
              )}
            </TabLink>
          ))}
        </nav>
        {d && <DatasetBanners projectId={projectId} dataset={d} />}
        {!d ? <ViewSkeleton /> : <DatasetView tab={tab} projectId={projectId} dataset={d} profile={profile} structure={structure} canEdit={canEdit} />}
      </div>
    </AppLayout>
  );
}

function DatasetView({ tab, ...props }: DatasetViewProps & { tab: DatasetTab }) {
  switch (tab) {
    case "overview":
      return <DatasetOverview {...props} />;
    case "structure":
      return <DatasetStructure {...props} />;
    case "fields":
      return <FieldsAndFormats {...props} />;
    case "annotations":
      return <AnnotationDefinitions {...props} />;
    case "quality":
      return <DatasetQuality {...props} />;
    case "versions":
      return <DatasetHistory {...props} />;
    case "publish":
      return <Publish dataset={props.dataset} />;
  }
}

function ViewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[104px] rounded-lg" />)}
      </div>
      <Skeleton className="h-32 rounded-lg" />
    </div>
  );
}

// ---- Header ------------------------------------------------------------------------------------

function DatasetHeader({ projectId, dataset: d, profile, canEdit }: { projectId: string; dataset?: DatasetSummary; profile?: DatasetProfile; canEdit: boolean }) {
  const setAssistant = useShell((s) => s.setAssistant);
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const addData = useAddData(projectId, d);
  const status = d ? datasetStatus(d, profile) : undefined;
  if (!d)
    return (
      <div className="mb-5">
        <SkeletonText variant="subheader" className="w-1/3" />
        <SkeletonText className="mt-2 w-1/2" />
      </div>
    );
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3" data-testid="dataset-header">
      <div className="min-w-0 max-w-2xl">
        <div className="flex flex-wrap items-center gap-2">
          <RenameInPlace projectId={projectId} kind="dataset" id={d.id} name={d.title} className="flex min-w-0 items-center gap-1" editing={renaming} onEditingChange={setRenaming}>
            <h1 className="text-header-2 font-semibold" data-testid="dataset-title">{d.title}</h1>
          </RenameInPlace>
          {status && <Badge theme={STATUS_THEME[status]} data-testid="dataset-status">{STATUS_LABEL[status]}</Badge>}
          {d.definition.seed && <Badge theme="unknown">Sample</Badge>}
          {!canEdit && <ReadOnlyBadge />}
        </div>
        {d.description && <p className="mt-1 text-sm text-muted-foreground">{d.description}</p>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0">
        <SnapshotPicker projectId={projectId} dataset={d} profile={profile} />
        {canEdit && (
          <Button variant="outline" size="lg" onClick={() => addData("drop")} title="Drop files or describe what to add; they go to this dataset" data-testid="dataset-add-data">
            <AddDataIcon /> Add data
          </Button>
        )}
        {canEdit && (
          <Button variant="outline" size="lg" onClick={() => setAssistant(true, true)} title="Describe the change; nothing is applied until you confirm it" data-testid="propose-change">
            <AiIcon className="text-ai-text" /> Propose change
          </Button>
        )}
        {canEdit && (
          <Button size="lg" asChild>
            <Link to={datasetUrl(projectId, d.id, "publish")} data-testid="dataset-publish"><ExportIcon /> Publish</Link>
          </Button>
        )}
        <ResourceMenu projectId={projectId} kind="dataset" id={d.id} name={d.title} canEdit={canEdit} testId="dataset-header-menu" onRename={() => setRenaming(true)} onDeleted={() => navigate(projectUrl(projectId, "datasets"))} />
      </div>
    </div>
  );
}

/**
 * Which snapshot the page shows (§2.2): the working draft, `main` or a release (read-only).
 * Phase 1 reads the working draft; `main` and releases open in History, where versions are
 * browsed, so a draft is never shown as if it were published.
 */
function SnapshotPicker({ projectId, dataset: d, profile }: { projectId: string; dataset: DatasetSummary; profile?: DatasetProfile }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const on = useQuery({ queryKey: ["versioning", d.id, "enabled"], queryFn: () => versioningEnabled(d.id), staleTime: Infinity });
  const releases = useQuery({ queryKey: ["versioning", d.id, "releases"], queryFn: () => versioning.releases(d.id, d.id), enabled: open && !!on.data });
  const history = (ref: string) => navigate(`${datasetUrl(projectId, d.id, "versions")}?ref=${encodeURIComponent(ref)}`);
  const label = profile?.snapshot.label ?? "Working draft";
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="lg" aria-label={`Snapshot: ${label}`} data-testid="snapshot-picker">
          <BranchIcon /> {label} <ChevronDownIcon className="opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Showing</DropdownMenuLabel>
        <DropdownMenuItem className="items-start" onSelect={(e) => e.preventDefault()}>
          <CheckIcon className="mt-0.5 text-brand" />
          <span className="flex flex-col">
            <span>Working draft</span>
            <span className="text-xs text-muted-foreground">Editable, not published</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {on.data ? (
          <>
            <DropdownMenuItem className="items-start pl-8" onSelect={() => history("main")} data-testid="snapshot-main">
              <span className="flex flex-col">
                <span>main</span>
                <span className="text-xs text-muted-foreground">Latest approved, read-only, opens in History</span>
              </span>
            </DropdownMenuItem>
            {(releases.data?.items ?? []).slice(0, 5).map((r) => (
              <DropdownMenuItem key={r.tag} className="pl-8" onSelect={() => history(`release:${r.tag}`)} data-testid="snapshot-release">
                <TagIcon /> Release {r.tag} <span className="ml-auto text-xs text-muted-foreground">Read-only</span>
              </DropdownMenuItem>
            ))}
          </>
        ) : (
          <p className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="snapshot-versioning-off">
            Approved versions and releases appear here once versioning is turned on.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TabLink({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex h-9 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 pt-0.5 text-sm transition-colors [outline-offset:-2px] hover:text-foreground [&_[data-counter]]:text-hint",
          isActive ? "border-brand text-foreground [&_[data-counter]]:text-muted-foreground" : "border-transparent text-muted-foreground",
        )
      }
    >
      {children}
    </NavLink>
  );
}

// ---- Pinned files that could change (todo7 D6 / D7) --------------------------------------------

/**
 * A dataset pins file versions and freezes its file list, so these say when it could change:
 * newer versions of its files (Update, with a preview), and new files in the folders it
 * followed (Add them).
 */
function DatasetBanners({ projectId, dataset }: { projectId: string; dataset: DatasetSummary }) {
  const update = useUpdateVersions(projectId, dataset.id);
  const addFollowed = useAddFollowed(projectId, dataset.id);
  const s = dataset.staleness;
  if (!s || (!s.newerVersions && !s.newFilesInFollowed)) return null;
  const fail = (e: unknown) => notify(e instanceof NeedsApiError ? "Needs the full stack" : e instanceof Error ? e.message : String(e), { tone: "error" });
  return (
    <div className="mb-4 space-y-2" data-testid="dataset-banners">
      <NewerVersionsBanner
        count={s.newerVersions}
        loadPreview={() => fetchUpdateVersionsPreview(projectId, dataset.id).then((r) => r.files)}
        onUpdate={async (nodeIds) => {
          await update.mutateAsync({ nodeIds });
          notify(`Updated ${nodeIds.length} ${nodeIds.length === 1 ? "file" : "files"} to the newest version`, { tone: "success" });
        }}
      />
      <FollowedFoldersBanner
        count={s.newFilesInFollowed}
        folders={s.followedFolderNames}
        busy={addFollowed.isPending}
        onAdd={() =>
          addFollowed.mutateAsync().then(
            () => void notify(`Added ${s.newFilesInFollowed} new ${s.newFilesInFollowed === 1 ? "file" : "files"} to ${dataset.title}`, { tone: "success" }),
            (e: unknown) => void fail(e),
          )
        }
      />
    </div>
  );
}

// ---- Publish & export (the export page, per task) ----------------------------------------------

function Publish({ dataset: d }: { dataset: DatasetSummary }) {
  const [exportTask, setExportTask] = useState<string | null>(null);
  const tasks = d.tasks;
  const taskForExport = exportTask ?? tasks[0]?.id;
  if (!tasks.length) return <p className="text-sm text-muted-foreground">Nothing to export yet: this dataset has no task.</p>;
  return (
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
  );
}
