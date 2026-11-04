import { Component, startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from "react";
import { Link, useBlocker, useLocation, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CanvasStatusBar } from "@/studio/components/studio/CanvasStatusBar";
import { CanvasToolbar } from "@/studio/components/studio/CanvasToolbar";
import { DecisionBar } from "@/studio/components/studio/DecisionBar";
import { LeftSidebar, SlotTabs } from "@/studio/components/studio/LeftSidebar";
import { StudioLayout } from "@/studio/components/studio/StudioLayout";
import { StudioTopBar } from "@/studio/components/studio/StudioTopBar";
import { ShortcutsDialog } from "@/studio/components/studio/ShortcutsDialog";
import { BootTimelineOverlay, bootTimelineEnabled } from "@/studio/components/studio/BootTimelineOverlay";
import { remountsOnItemSwitch, ViewportHost } from "@/studio/components/studio/ViewportHost";
import { FileView } from "@/studio/components/studio/FileView";
import { activeProfile, envForProfile } from "@/studio/lib/active-profile";
import { Sheet, SheetContent } from "@studio/ui/ui/sheet";
import { useViewport } from "@/studio/lib/use-media-query";
import { fetchAnnotations, fetchEnvironment, fetchTaskDocument, saveAnnotations } from "@/studio/lib/api";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@studio/ui/ui/alert-dialog";
import { mergeAnnotations, resolveConflict, useSaveConflicts } from "@/studio/lib/annotation-merge";
import { toProblem } from "@/studio/lib/problem";
import { invalidateFor } from "@/studio/lib/invalidate";
import { retryDelayMs, useSaveProblem } from "@/studio/lib/save-problem";
import { useLiveDropItems } from "@/studio/core/drops";
import { useLiveSuggestions } from "@/studio/lib/live-suggestions";
import { setLabelClasses } from "@studio/plugin-ui-sdk/labels";
import { ANNOTATIONS_VERSION } from "@studio/contracts/migrations/annotations-v1-to-v2";
import { setActiveCommands, SHELL_PRIORITY, useCommands, useHotkeys } from "@/extension-host/commands";
import { labelClasses, regionLabelNames } from "@studio/contracts/environment";
import { digitOf, matches } from "@studio/ui/keys";
import { registry } from "@/extension-host/registry";
import { applySafeWorkspace, applyWorkspace, fetchWorkspaceState, loadRemotePlugins } from "@/extension-host/workspace";
import { kernelEnabled, prepareAssetUrls } from "@/extension-host/kernel";
import { Button, buttonVariants } from "@studio/ui/ui/button";
import { ErrorState } from "@studio/ui/ui/error-state";
import { fetchKnownGood, isSafeMode, reportCleanBoot, rollback, safeHref, type KnownGood } from "@/studio/lib/safe-mode";
import { bindDeclarativeCommands, itemMediaType } from "@/extension-host/contributions-loader";
import { itemWhenContext, resolveEnvironment, type EnvError, type ResolvedEnv } from "@/extension-host/resolve";
import { clearRuntime, publish, REQUESTED_PLACEMENT, useRuntime } from "@studio/plugin-ui-sdk/runtime";
import { api, fetchTaskIncludingTrashed, putResume, useProjectSummary } from "@/studio/lib/projects-api";
import { projectTrashUrl } from "@/studio/lib/routes";
import { useRestoreBatch } from "@/studio/lib/trash-api";
import { markReloadRestored, openedByReload, placementOf } from "@/studio/lib/resume";
import { apiUrl } from "@/extension-host/runtime-config";
import { brushSizeOf, isEditable, useStudio, visibleFor } from "@/studio/stores/studio";
import { rememberTool } from "@/studio/stores/tool-prefs";
import { nextTodoIndex } from "@/studio/lib/items";
import { studioItems } from "@/studio/lib/item-folders";
import { useTaskItems } from "@/studio/lib/task-items";
import type { AnnotationDocument, Placement, Plane, Project, ResumeState, StudioItem } from "@studio/contracts/types";
import { AppLayout } from "@/studio/components/layout/app-layout";
import { useShell } from "@/studio/stores/shell";
import { FullPageMessage } from "./shared";
import { CanvasDropTarget, CanvasEmptyState } from "@/studio/app/entry/empty-states";
import { useLiveEnvironment, useSetupStale } from "@/studio/lib/live-environment";
import { ShellTransition } from "@/studio/lib/view-transition";
import { NAMING, RES, ns } from "@studio/contracts/naming";
import { prefSegment } from "@/studio/lib/person-prefs";
import { personKey } from "@/studio/lib/person-key";
import { markAfterPaint, markBoot, startBoot } from "@/extension-host/boot-timing";
import { loadInPriority, newModules, warmFromHint, warmFromSpec } from "@/studio/lib/boot-priority";
import { loadDocument, saveVersioned, StaleHeadError, useVersioning } from "@/studio/core/versioning";
import { apiFetch } from "@/extension-host/http";
import { onBeforeSignIn, useSignIn } from "@/studio/lib/session";
import { stashUnsaved, takeUnsaved } from "@/studio/lib/unsaved";

const AUTOSAVE_MS = 800;
/** The environment query refetches at most this often (focus, remount); events carry the rest. */
const ENV_STALE_MS = 30_000;
const LEGACY_TYPES = /^(interval|beat|wave|rhythm|phase|segment|event|mark|point)$/;

export type Boot = { status: "loading" } | { status: "errors"; errors: EnvError[] } | { status: "failed"; message: string } | { status: "ready"; env: ResolvedEnv };

/**
 * Resolve the task's environment (its saved edits, else the manifest's). Ready as soon as it
 * resolves: modules load in priority order behind it (viewer, visible panels, the rest) and
 * each viewport or panel waits for its own (ModuleSlot), so nothing waits for every module
 * (todo11 Milestone 1). `taskId` lets the environment and workspace fetches start on route
 * enter, alongside the task document instead of after it.
 */
export function useEnvironment(project: Project | undefined, { safe = false, taskId }: { safe?: boolean; taskId?: string } = {}): Boot {
  const id = taskId || project?.id;
  // Kept current by `environment.updated` (useLiveEnvironment), not by staleTime: Infinity;
  // a refetch after a missed event applies too.
  const saved = useQuery({ queryKey: ["environment", id], queryFn: () => fetchEnvironment(id!).catch(() => null), enabled: !!id && !safe, staleTime: ENV_STALE_MS });
  // Safe mode (todo10 §3.4): the task's last-known-good setup instead of its saved one.
  const known = useQuery({ queryKey: ["known-good", id], queryFn: () => fetchKnownGood(id!).catch(() => null), enabled: !!id && safe, staleTime: 0 });
  // The workspace's active plugins (kernel Workspace API; in dev seed-data/<project>/workspace.json).
  // Safe mode never loads a remote (non-first-party) plugin, and boots even if the state route fails.
  const workspace = useQuery({
    queryKey: ["workspace", id, safe ? "safe" : "normal"],
    queryFn: async () => {
      await prepareAssetUrls(id!);
      if (safe) return fetchWorkspaceState(id!).catch(() => null);
      const state = await fetchWorkspaceState(id!);
      await loadRemotePlugins(state);
      return state;
    },
    enabled: !!id,
    staleTime: Infinity,
  });
  const [boot, setBoot] = useState<Boot>({ status: "loading" });
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (workspace.isLoading || workspace.error || (safe && known.isLoading)) return;
    if (safe) applySafeWorkspace(workspace.data ?? null, known.data?.lockfile ?? null);
    else applyWorkspace(workspace.data ?? null);
    setApplied(true);
  }, [workspace.isLoading, workspace.error, workspace.data, safe, known.isLoading, known.data]);
  // The saved spec is known before the workspace applies: start its viewer's chunk now.
  const spec = safe ? known.data?.environment : saved.data?.environment;
  const fetched = safe ? !known.isLoading : !saved.isLoading;
  useEffect(() => {
    if (!fetched) return;
    markBoot("env-fetched");
    warmFromSpec(spec);
  }, [fetched, spec]);
  // Re-resolve when plugins are enabled or disabled (e.g. enabling one this environment needs).
  const activation = useSyncExternalStore((l) => registry.subscribe(l), () => registry.activationVersion);
  useEffect(() => {
    if (workspace.error) return setBoot({ status: "failed", message: String(workspace.error) });
    if (!project || !fetched || !applied) return;
    const r = resolveEnvironment(spec ?? project.environment, registry);
    if (r.errors) return setBoot({ status: "errors", errors: r.errors });
    markBoot("env-resolved");
    loadInPriority(r.env, project.id);
    setBoot({ status: "ready", env: r.env });
  }, [project, fetched, spec, applied, activation, workspace.error]);
  return boot;
}

/** The task's document (`GET /v1/tasks/:id/document`), shared with Overview's resume card. */
export function useTaskDocument(taskId: string) {
  return useQuery({ queryKey: ["tasks", taskId, "document"], queryFn: () => fetchTaskDocument(taskId), enabled: !!taskId, staleTime: Infinity });
}

/** `/projects/:projectId/studio/:taskId` (the legacy `/datasets/:id` redirects here). */
export function DatasetStudioPage() {
  return (
    <AppLayout studio>
      <SmallScreenNotice />
      <StudioPage />
    </AppLayout>
  );
}

/** Phones still open the Studio, but say where annotation works best (docs/ux.md §4). */
function SmallScreenNotice() {
  const viewport = useViewport();
  const [dismissed, setDismissed] = useState(false);
  if (viewport !== "phone" || dismissed) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-info-tint px-3 py-2 text-sm" role="status" data-testid="small-screen-notice">
      <span className="min-w-0 flex-1">Annotation works best on a larger screen.</span>
      <button type="button" className="shrink-0 text-muted-foreground underline" onClick={() => setDismissed(true)}>Dismiss</button>
    </div>
  );
}

function StudioPage() {
  const { taskId, datasetId: legacyId } = useParams();
  const datasetId = taskId ?? legacyId ?? "";
  // Route enter (todo11 Milestone 1): start the boot timeline and this task's last viewer chunk.
  const [entered, setEntered] = useState("");
  if (entered !== datasetId) {
    setEntered(datasetId);
    startBoot(datasetId);
    warmFromHint(datasetId);
  }
  const { data: project, isLoading, error } = useTaskDocument(datasetId);
  // A Studio whose dataset is in Trash says so instead of opening (todo16 round 2).
  const routeProjectId = useParams().projectId ?? "";
  const summary = useQuery({ queryKey: ["tasks", datasetId, "summary", "withTrashed"], queryFn: () => fetchTaskIncludingTrashed(datasetId), enabled: kernelEnabled() && !!datasetId, staleTime: 30_000 });
  const restoreDataset = useRestoreBatch(routeProjectId);
  const qc = useQueryClient();
  // todo13 J3: a drop applied to this Studio's collection shows up without a reload.
  useLiveDropItems(datasetId);
  // todo25 W5: masks from a running batch land in the open Studio as each job finishes.
  useLiveSuggestions(useStudio((s) => s.projectId) ?? undefined, routeProjectId);
  // With dataset versioning on (the kernel reports it configured), this is the user's work
  // branch; otherwise the plain document, exactly as before.
  const saved = useQuery({ queryKey: ["annotations", datasetId], queryFn: () => loadDocument(datasetId, () => fetchAnnotations(datasetId)), enabled: !!project, staleTime: Infinity });
  const location = useLocation();
  const safe = isSafeMode(location.search);
  const boot = useEnvironment(project, { safe, taskId: datasetId });
  const projectId = useStudio((s) => s.projectId);
  const load = useStudio((s) => s.load);
  const setEnv = useStudio((s) => s.setEnv);

  useEffect(() => {
    // The store, not this render's `projectId`: StrictMode runs the effect twice with one closure.
    if (project && saved.data && boot.status === "ready" && useStudio.getState().projectId !== project.id) {
      clearRuntime();
      setEnv(boot.env, { record: false });
      // Edits kept across a sign-in redirect (session expired mid-work) come back unsaved.
      const kept = takeUnsaved(project.id);
      load(project.id, kept?.annotations ?? saved.data.annotations, kept?.revision ?? saved.data.revision, regionLabelNames(boot.env.labels)[0] ?? null);
      useSaveConflicts.getState().setBase(project.id, saved.data.annotations); // todo18 P0-4 merge base
      useSaveConflicts.getState().set([]);
      if (kept) useStudio.setState({ dirty: true, saveState: "idle" });
    }
  }, [project, saved.data, projectId, load, boot, setEnv]);

  const trashed = summary.data as { datasetTrashed?: boolean; datasetTrashBatchId?: string | null } | undefined;
  if (trashed?.datasetTrashed)
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="empty-dataset-in-trash">
        <ErrorState
          variant="page"
          kind="not-found"
          title="This Studio's dataset is in Trash"
          description="Restore the dataset to open its Studio again. Trash keeps it for 30 days."
          actions={
            routeProjectId ? (
              <>
                {trashed.datasetTrashBatchId && (
                  <Button size="lg" disabled={restoreDataset.isPending} onClick={() => restoreDataset.mutate(trashed.datasetTrashBatchId!, { onSuccess: () => invalidateFor(qc, routeProjectId, "trash.changed") })} data-testid="empty-dataset-in-trash-restore">
                    Restore dataset
                  </Button>
                )}
                <Link to={projectTrashUrl(routeProjectId)} className={buttonVariants({ size: "lg", variant: trashed.datasetTrashBatchId ? "outline" : "default" })}>Open Trash</Link>
              </>
            ) : undefined
          }
        />
      </div>
    );
  if (isLoading || saved.isLoading) return <FullPageMessage title="Opening Studio" loading shape="studio" />;
  if (error || !project) return <FullPageMessage kind="not-found" title="Task not found" body={`No task “${datasetId}” in this project. Seeds need pnpm seeds, then a reload.`} />;
  if (saved.error) return <FullPageMessage kind="error" title="Couldn't load annotations" body={String(saved.error)} />;
  if (boot.status === "errors") return <EnvErrors errors={boot.errors} safe={safe} />;
  if (boot.status === "failed") return <BrokenStudio title="Couldn't load this environment's modules" message={boot.message} safe={safe} />;
  if (boot.status === "loading" || projectId !== project.id) return <FullPageMessage title="Opening Studio" loading />;
  return (
    <StudioBoundary safe={safe}>
      {safe && <SafeModeBanner taskId={project.id} />}
      <Studio key={project.id} projectId={project.id} safe={safe} />
      {bootTimelineEnabled(location.search) && <BootTimelineOverlay />}
    </StudioBoundary>
  );
}

/** "Start in safe mode" on every screen a broken setup can leave a person on (todo10 §3.4). */
function SafeModeButton() {
  return (
    <a href={safeHref(true)} className={buttonVariants({ size: "lg" })} data-testid="start-safe-mode">
      Start in safe mode
    </a>
  );
}

function BrokenStudio({ title, message, safe }: { title: string; message: string; safe: boolean }) {
  return (
    <ErrorState
      variant="page"
      kind="error"
      title={title}
      description={safe ? `${message} (already in safe mode: only first-party plugins and the last known good setup.)` : `${message} Safe mode starts the last known good setup with only first-party plugins; nothing is changed until you restore it.`}
      actions={
        <>
          {!safe && <SafeModeButton />}
          <Link to="/projects" className={buttonVariants({ variant: "outline", size: "lg" })}>Back to projects</Link>
        </>
      }
    />
  );
}

/** A renderer or panel that throws while rendering shows the way out instead of a blank page. */
class StudioBoundary extends Component<{ safe: boolean; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[studio] crashed", error, info.componentStack);
  }
  render() {
    if (this.state.error) return <div className="flex min-h-0 flex-1 flex-col" data-testid="studio-crashed"><BrokenStudio title="The Studio stopped working" message={this.state.error.message} safe={this.props.safe} /></div>;
    return this.props.children;
  }
}

/** Safe mode: what's running, and the two ways out (restore it for real, or leave). */
function SafeModeBanner({ taskId }: { taskId: string }) {
  const known = useQuery({ queryKey: ["known-good", taskId], queryFn: () => fetchKnownGood(taskId).catch(() => null), staleTime: 0 });
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const k: KnownGood | null | undefined = known.data;
  const restore = async () => {
    setState({ busy: true, error: null });
    try {
      await rollback(taskId);
      window.location.assign(safeHref(false));
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-warning-tint px-3 py-2 text-sm" role="status" data-testid="safe-mode-banner">
      <span className="min-w-0 flex-1">
        <strong>Safe mode.</strong> Only first-party plugins are on, running{" "}
        {k ? <>the last known good setup (revision {k.revision}, marked by {k.movedBy.replace(/^user:/, "")}{k.movedBecause === "checks" ? " after a clean start" : ""})</> : <>this task's original setup</>}. Nothing has changed yet.
        {state.error && <span className="ml-2 text-danger">{state.error}</span>}
      </span>
      {k && kernelEnabled() && (
        <Button size="sm" onClick={() => void restore()} disabled={state.busy} data-testid="safe-mode-rollback" title="Make the last known good setup (environment and plugins) the current one again">
          Restore this setup
        </Button>
      )}
      <a href={safeHref(false)} className={buttonVariants({ size: "sm", variant: "outline" })} data-testid="safe-mode-exit">Leave safe mode</a>
    </div>
  );
}

/** Resolver errors, with the JSON Pointer of each problem so the spec can be fixed. */
function EnvErrors({ errors, safe }: { errors: EnvError[]; safe: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8">
      <h1 className="text-body-2 font-semibold">This environment doesn't resolve</h1>
      <ul className="max-w-2xl space-y-1.5 text-sm" data-testid="env-errors">
        {errors.map((e, i) => (
          <li key={i} className="rounded-md bg-warning-tint px-3 py-2">
            <code className="font-mono text-code">{e.path || "/"}</code> · {e.message}
            {e.suggestion && <span className="text-muted-foreground"> Did you mean <code className="font-mono">{e.suggestion}</code>?</span>}
          </li>
        ))}
      </ul>
      {!safe && (
        <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
          <SafeModeButton />
          Starts the last known good setup with only first-party plugins.
        </div>
      )}
    </div>
  );
}

/** Seconds a Studio must run without crashing before its setup counts as a clean start. */
const CLEAN_BOOT_MS = 5000;

/**
 * Passing checks (todo10 §3.4): a setup that resolved, loaded every module and rendered for a
 * few seconds may become last-known-good. The kernel decides: never an agent's change, never
 * plugins that widen permissions. Not in safe mode, not without the kernel.
 */
function useCleanBootReport(projectId: string, safe: boolean) {
  const env = useQuery({ queryKey: ["environment", projectId], queryFn: () => fetchEnvironment(projectId).catch(() => null), staleTime: ENV_STALE_MS, enabled: !safe });
  const doc = env.data;
  useEffect(() => {
    if (safe || !kernelEnabled() || env.isLoading) return;
    const t = setTimeout(() => void reportCleanBoot(projectId, doc?.revision ?? 0, doc?.contentHash), CLEAN_BOOT_MS);
    return () => clearTimeout(t);
  }, [projectId, safe, env.isLoading, doc?.revision, doc?.contentHash]);
}

function Studio({ projectId, safe = false }: { projectId: string; safe?: boolean }) {
  useCleanBootReport(projectId, safe);
  const { data: project } = useTaskDocument(projectId);
  useTaskItems(projectId); // todo11 D8: item.* events upgrade the document's items in place
  const baseEnv = useStudio((s) => s.env)!;
  const items = useMemo(() => (project ? studioItems(project, baseEnv) : []), [project, baseEnv]);
  const itemIndex = useStudio((s) => s.itemIndex);
  // todo19 D3: the active item's kind picks its profile (viewer, tools, panels, command scope).
  // Memoised per profile, so items of one kind keep the same env (and the renderer mounted).
  const active = activeProfile(baseEnv, items[itemIndex]);
  const activeKey = active.key;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `active` is derived from the key
  const env = useMemo(() => envForProfile(baseEnv, active, registry), [baseEnv, activeKey]);
  const aiOpen = useStudio((s) => s.aiOpen);
  const toggleAi = useStudio((s) => s.toggleAi);
  const leftOpen = useShell((s) => s.studioLeft);
  const save = useAutosave(projectId);
  // `projectId` here is the task (seed ids line up); the route names the project files go to.
  const routeProjectId = useParams().projectId ?? projectId;
  const viewport = useViewport();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Picking a file in the phone drawer should reveal the canvas.
  useEffect(() => setSidebarOpen(false), [itemIndex]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useEnvBindings(env, items);
  useActivationSync(env);
  useLiveEnvironment(projectId, safe);
  useResume(projectId, items, env);
  useStudioShortcuts(env, items, () => setShortcutsOpen(true));
  // Boot timeline: the chrome is on screen (modules may still be loading behind skeletons).
  useEffect(() => markAfterPaint("shell-painted", { env: env.id }), [env.id]);

  // Open on a tool this environment actually offers (whole-slide starts in pan, not select).
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  useEffect(() => {
    if (env.tools.length && !env.tools.some((t) => t.name === tool)) setTool(env.tools[0].name);
  }, [env, tool, setTool]);

  // The status line is also structured runtime state, so panels can read it.
  const viewerStatus = useStudio((s) => s.viewerStatus);
  const itemId = items[itemIndex]?.id;
  useEffect(() => {
    if (itemId) publish(itemId, "status", viewerStatus);
  }, [itemId, viewerStatus]);

  if (!project) return null;
  const item = items[itemIndex];
  const main = env.viewports[0];
  // The assistant toggles with the AI button; other right-slot panels (measurements,
  // metrics…) are always shown.
  const AI = ns("core.panels.ai");
  const hasAi = env.panels.right.some((p) => p.id === AI);
  const rightIds = env.panels.right.map((p) => p.id).filter((id) => id !== AI || aiOpen);
  const showRight = rightIds.length > 0;

  const bottomPanels = env.panels.bottom.length > 0 ? <SlotTabs slot="bottom" env={env} project={project} items={items} item={item} /> : null;
  // On phones the bottom slot sits under the canvas; elsewhere it's a dockview region.
  const bottom = viewport === "phone" && bottomPanels && <div className="max-h-[40%] min-h-0 shrink-0 overflow-auto border-t border-border">{bottomPanels}</div>;

  const canvas = (
    <>
      <CanvasToolbar env={env} project={project} items={items} item={item} />
      <main className="min-h-0 flex-1" aria-label="Viewer">
        {item ? (
          <CanvasDropTarget projectId={routeProjectId} taskId={projectId}>
            {env.showFileView ? (
              <FileView key={activeKey} item={item} kind={active.kind} />
            ) : env.viewports.length === 1 ? (
              <ViewportHost key={remountsOnItemSwitch(main) ? item.id : `${activeKey}:${main.name}`} env={env} viewport={main} project={project} item={item} />
            ) : (
              // Several viewports (e.g. a video next to its sensor trace) share the item and
              // stay in sync through runtime values such as `playhead`.
              <div className="flex h-full min-h-0 divide-x divide-border">
                {env.viewports.map((vp) => (
                  <div key={`${activeKey}:${vp.name}`} className="min-w-0 flex-1" data-viewport={vp.name}>
                    <ViewportHost key={remountsOnItemSwitch(vp) ? `${item.id}:${vp.name}` : `${activeKey}:${vp.name}`} env={env} viewport={vp} project={project} item={item} />
                  </div>
                ))}
              </div>
            )}
          </CanvasDropTarget>
        ) : (
          // todo13 D11: an empty canvas is a drop target, not a dead end.
          <CanvasEmptyState projectId={routeProjectId} taskId={projectId} />
        )}
      </main>
      {bottom}
      <DecisionBar env={env} items={items} />
      <CanvasStatusBar items={items} onShowShortcuts={() => setShortcutsOpen(true)} />
    </>
  );
  const left = <LeftSidebar env={env} project={project} items={items} item={item} />;
  const right = <SlotTabs slot="right" only={rightIds} env={env} project={project} items={items} item={item} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ShellTransition>
        <StudioTopBar
          project={project}
          onRetrySave={save}
          onOpenSidebar={viewport === "phone" ? () => setSidebarOpen(true) : undefined}
          onShowShortcuts={() => setShortcutsOpen(true)}
          showAi={hasAi || (viewport !== "desktop" && env.panels.right.length > 0)}
          showLeftToggle={viewport !== "phone" && env.panels.left.length > 0}
        />
      </ShellTransition>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} env={env} />
      <SaveConflictNotice />
      <UnsavedLeaveGuard save={save} />
      <SetupStaleBanner />
      <ShellTransition>
      {viewport === "phone" ? (
        <div className="flex min-h-0 flex-1 flex-col">{canvas}</div>
      ) : (
        <StudioLayout
          storageKey={personKey(`${RES}-layout-${projectId}-${viewport}`)}
          prefKey={`layout:${prefSegment(routeProjectId)}:${prefSegment(projectId)}:${viewport}`}
          layout={env.spec.layout ?? null}
          slots={{
            viewer: <div className="flex h-full min-h-0 flex-col">{canvas}</div>,
            // Hidden (with the rail hidden too) the canvas takes the full width; tools don't depend on any panel.
            "slot:left": env.panels.left.length > 0 && leftOpen ? left : null,
            // Below the desktop breakpoint the right slot is a sheet (see below).
            "slot:right": showRight && viewport === "desktop" ? right : null,
            "slot:bottom": bottomPanels,
          }}
        />
      )}
      </ShellTransition>

      {viewport === "phone" && (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" title="Items and labels" showClose={false}>
            {left}
          </SheetContent>
        </Sheet>
      )}
      {viewport !== "desktop" && env.panels.right.length > 0 && (
        <Sheet open={aiOpen} onOpenChange={(open) => open !== aiOpen && toggleAi()}>
          <SheetContent side="right" title={`${NAMING.displayName} AI`} showClose={false}>
            <SlotTabs slot="right" env={env} project={project} items={items} item={item} />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}


const RESUME_DEBOUNCE_MS = 1000;

/**
 * Resume (todo6 D9, Phase 7): where this person is (task, item, frame or slice, tool) is
 * written to the project as they work, debounced and on `pagehide`. It's restored when the
 * Studio was opened to resume (Overview's "Open Studio", Home's "Resume", the Studio nav
 * item: router state `{ resume: true }`, or `?resume` in the URL) and on a reload, never on
 * a plain link to the task.
 */
function useResume(taskId: string, items: StudioItem[], env: ResolvedEnv) {
  const routeProject = useParams().projectId;
  const summary = useProjectSummary(routeProject);
  const projectId = summary.data?.id;
  const location = useLocation();
  const [byReload] = useState(() => openedByReload(location.pathname));
  // Data's "Open in Studio" (todo8 D3) names the item: `{ itemId, nodeId? }`; it wins over the saved place.
  const opened = location.state as { resume?: boolean; itemId?: string; nodeId?: string } | null;
  const wantRestore = byReload || !!opened?.resume || !!opened?.itemId || new URLSearchParams(location.search).has("resume");
  const resume = useQuery({ queryKey: ["projects", projectId, "resume"], queryFn: () => api<{ resume: ResumeState | null }>(`/projects/${encodeURIComponent(projectId!)}/resume`), enabled: !!projectId && wantRestore, staleTime: 0, gcTime: 0 });
  // Settled: restored, or nothing to restore. Writes wait for it, so item 0 never overwrites
  // what is about to be restored.
  const [settled, setSettled] = useState(!wantRestore);
  useEffect(() => {
    if (settled || summary.isLoading || (projectId && resume.isLoading) || !items.length) return;
    setSettled(true);
    markReloadRestored();
    const s = useStudio.getState();
    // A reload keeps the router state, but then the saved place (where they went since) wins.
    if (opened?.itemId && !byReload) {
      const at = items.findIndex((i) => i.id === opened.itemId || (!!opened.nodeId && (i.nodeId === opened.nodeId || i.assets.some((a) => a.nodeId === opened.nodeId))));
      if (at >= 0) return s.setItemIndex(at);
    }
    const r = resume.data?.resume;
    if (!r || r.taskId !== taskId) return;
    const at = items.findIndex((i) => i.id === r.itemId);
    if (at >= 0) s.setItemIndex(at);
    if (r.tool && env.tools.some((t) => t.name === r.tool)) s.setTool(r.tool);
    // Frame or slice: the renderer applies it once it can (useRequestedPlacement).
    if (at >= 0 && r.placement && Object.keys(r.placement).length) publish(items[at].id, REQUESTED_PLACEMENT, r.placement);
  }, [settled, summary.isLoading, projectId, resume.isLoading, resume.data, taskId, items, env, opened?.itemId, opened?.nodeId, byReload]);

  const itemIndex = useStudio((s) => s.itemIndex);
  const tool = useStudio((s) => s.tool);
  const itemId = items[itemIndex]?.id;
  const playhead = useRuntime<{ frame?: number; slice?: number }>(itemId, "playhead");
  const view = useRuntime<{ activePlane?: Plane; slices?: Partial<Record<Plane, number>> }>(itemId, "viewportState");
  // Until the renderer applies a requested placement, that's where the person is.
  const requested = useRuntime<Placement>(itemId, REQUESTED_PLACEMENT);
  const key = JSON.stringify(requested ?? placementOf(playhead, view));
  const body = useMemo(() => (settled && projectId && itemId ? { taskId, itemId, tool, placement: JSON.parse(key) as Placement } : null), [settled, projectId, taskId, itemId, tool, key]);
  const latest = useRef(body);
  latest.current = body;
  useEffect(() => {
    if (!body || !projectId) return;
    const t = setTimeout(() => void putResume(projectId, body).catch(() => undefined), RESUME_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [body, projectId]);
  useEffect(() => {
    if (!projectId) return;
    const flush = () => {
      if (latest.current) void apiFetch(apiUrl(`/v1/projects/${encodeURIComponent(projectId)}/resume`), { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(latest.current) }).catch(() => undefined);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [projectId]);
}

/**
 * Re-resolve when the workspace's active plugins change (enable / disable without a reload).
 * The new environment replaces the old one without an undo step; annotations stay in the
 * store whatever happens, and types of a disabled plugin show as unavailable.
 */
function useActivationSync(env: ResolvedEnv) {
  const activation = useSyncExternalStore(
    (l) => registry.subscribe(l),
    () => registry.activationVersion,
  );
  const first = useRef(activation);
  useEffect(() => {
    if (activation === first.current) return;
    first.current = activation;
    const r = resolveEnvironment(env.source, registry);
    if (r.errors) {
      console.warn("[plugins] the environment no longer resolves with this workspace's plugins", r.errors);
      return;
    }
    // Only the modules this workspace change added load; the Studio keeps running meanwhile.
    newModules(r.env).forEach((id) => registry.ensure(id));
    startTransition(() => useStudio.getState().setEnv(r.env, { record: false }));
  }, [activation, env.source]);
}

/** Bind the environment's commands and label colors for as long as it runs. */
function useEnvBindings(env: ResolvedEnv, items: StudioItem[]) {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    const current = () => itemsRef.current[useStudio.getState().itemIndex];
    setLabelClasses(labelClasses(env.labels));
    setActiveCommands(env.commands, () => {
      const s = useStudio.getState();
      return {
        ...env.context,
        tool: s.tool,
        "tool.options": Object.keys(s.toolOptions[s.tool] ?? {}),
        "selection.count": s.selectedIds.length,
        "env.tools": env.tools.map((t) => t.name),
        "item.mediaType": itemMediaType(current()),
        ...itemWhenContext(env, current()),
      };
    });
    // Declarative plugin commands (toolbar actions) run through the command gateway.
    const unbind = bindDeclarativeCommands(env, () => {
      const it = current();
      return { itemId: it?.id, assetIds: it?.assets.map((a) => a.path), selection: useStudio.getState().selectedIds };
    });
    if (import.meta.env.DEV) console.debug(`[${RES}] environment ${env.id}: ${env.modules.map((m) => `${m.id}@${m.version}`).join(", ")}`);
    return () => {
      unbind();
      setActiveCommands([]);
    };
  }, [env]);
}

/** todo18 §2 C: a newer setup can't run here (e.g. a plugin was disabled mid-session). */
function SetupStaleBanner() {
  const stale = useSetupStale((s) => s.stale);
  if (!stale) return null;
  return (
    <div role="alert" data-testid="setup-stale-banner" className="flex items-center gap-2 border-b bg-amber-50 px-3 py-1.5 text-sm dark:bg-amber-950">
      <span className="flex-1">Setup changed and can't be applied: {stale.reason}. Your annotations still save.</span>
      <button type="button" className="rounded border px-2 py-0.5" onClick={() => (stashUnsaved(), window.location.reload())}>Reload</button>
    </div>
  );
}

/**
 * todo18 §2 C: leaving the Studio inside the app with unsaved edits saves first; only if that
 * fails does the person choose (an in-app dialog, never `window.confirm`, so automation can't hang).
 * Leaving anyway keeps the edits in this tab's stash; they come back when the Studio reopens.
 */
function UnsavedLeaveGuard({ save }: { save: () => Promise<void> }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => useStudio.getState().dirty && currentLocation.pathname !== nextLocation.pathname);
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    let live = true;
    void save().then(() => {
      if (!live || blocker.state !== "blocked") return;
      if (!useStudio.getState().dirty) blocker.proceed();
      else setAsk(true);
    });
    return () => {
      live = false;
    };
  }, [blocker, save]);
  const close = (leave: boolean) => {
    setAsk(false);
    if (blocker.state !== "blocked") return;
    if (leave) {
      stashUnsaved();
      blocker.proceed();
    } else blocker.reset();
  };
  return (
    <AlertDialog open={ask} onOpenChange={(o) => !o && close(false)}>
      <AlertDialogContent data-testid="unsaved-leave-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Your latest annotations aren't saved</AlertDialogTitle>
          <AlertDialogDescription>We couldn't save them just now. If you leave, they're kept in this tab and come back when you reopen this Studio.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="unsaved-leave-stay" onClick={() => close(false)}>Stay</AlertDialogCancel>
          <AlertDialogAction data-testid="unsaved-leave-go" onClick={() => close(true)}>Leave anyway</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** todo18 P0-4: the same annotation was changed here and by someone else; the person picks Theirs or Mine. */
function SaveConflictNotice() {
  const conflicts = useSaveConflicts((s) => s.conflicts);
  const c = conflicts[0];
  if (!c) return null;
  const pick = (choice: "mine" | "theirs") => {
    const st = useStudio.getState();
    useStudio.setState({ annotations: resolveConflict(st.annotations, c, choice), dirty: true });
    useSaveConflicts.getState().drop(c.id);
  };
  const what = c.mine?.label ?? c.theirs?.label ?? c.id;
  return (
    <div role="status" data-testid="save-conflict-notice" className="flex items-center gap-2 border-b bg-amber-50 px-3 py-1.5 text-sm dark:bg-amber-950">
      <span className="flex-1">Someone else changed this {what} annotation too{conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : ""}. Keep which version?</span>
      <button type="button" className="rounded border px-2 py-0.5" data-testid="save-conflict-theirs" onClick={() => pick("theirs")}>Theirs</button>
      <button type="button" className="rounded border px-2 py-0.5" data-testid="save-conflict-mine" onClick={() => pick("mine")}>Mine</button>
    </div>
  );
}

/** Debounced save; the indicator only shows "Saved" after the server returns the new revision. */
function useAutosave(projectId: string) {
  const annotations = useStudio((s) => s.annotations);
  const dirty = useStudio((s) => s.dirty);
  const inFlight = useRef(false);
  const merges = useRef(0);
  const qc = useQueryClient();
  const routeProject = useParams().projectId ?? "";
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(retry.current), []);

  const save = useCallback(async () => {
    const run = async (): Promise<void> => {
      const s = useStudio.getState();
      if (inFlight.current || !s.dirty) return;
      inFlight.current = true;
      const snapshot = s.annotations;
      s.markSaving();
      try {
        if (useVersioning.getState().enabled) {
          // A commit on the work branch with expected_head (core/versioning).
          useStudio.getState().markSaved(await saveVersioned(projectId, snapshot), snapshot);
        } else {
          const v2 = !snapshot.some((a) => LEGACY_TYPES.test(a.geometry.type));
          const doc = await saveAnnotations(projectId, { revision: s.revision, annotations: snapshot, ...(v2 ? { annotationsVersion: ANNOTATIONS_VERSION } : {}) });
          useSaveConflicts.getState().setBase(projectId, snapshot);
          useStudio.getState().markSaved(doc.revision, snapshot);
        }
        merges.current = 0;
        if (useSaveProblem.getState().problem) {
          useSaveProblem.getState().set(null);
          takeUnsaved(projectId); // saved at last: drop the offline stash
        }
      } catch (e) {
        const p = toProblem(e);
        const current = p.current as AnnotationDocument | undefined;
        if (p.kind === "conflict" && current && Array.isArray(current.annotations) && merges.current++ < 3) {
          // Someone saved since we loaded: merge per annotation id, then save the merge on their revision.
          const b = useSaveConflicts.getState();
          const { merged, conflicts } = mergeAnnotations(b.baseProject === projectId ? b.base : [], useStudio.getState().annotations, current.annotations);
          b.setBase(projectId, current.annotations);
          useStudio.setState({ annotations: merged, revision: current.revision, dirty: true, saveState: "saving" });
          if (conflicts.length) useSaveConflicts.getState().set(conflicts);
          inFlight.current = false;
          await run();
          return;
        }
        // A stale head shows "someone else saved; refresh and re-apply" in the top bar.
        if (!(e instanceof StaleHeadError)) console.warn("[save]", e);
        useSaveProblem.getState().set(p);
        useStudio.getState().markError();
        // 410: the Studio (or its dataset) went to Trash under us; the page switches to "Moved to Trash" with Restore.
        if (p.status === 410) invalidateFor(qc, routeProject, "trash.changed");
        if (p.retryable) {
          // Offline / 5xx / 429 (todo18 §2 C): keep the edits in this tab and retry with back-off.
          stashUnsaved();
          clearTimeout(retry.current);
          retry.current = setTimeout(() => void run(), retryDelayMs(p, useSaveProblem.getState().attempt));
        }
        return;
      } finally {
        inFlight.current = false;
      }
      // Edits made while the request was in flight still need saving.
      if (useStudio.getState().dirty) await run();
    };
    await run();
  }, [projectId, qc, routeProject]);

  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(save, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [annotations, dirty, save]);


  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      // Leaving to sign in again keeps the edits (onBeforeSignIn below): no "leave site?" prompt.
      if (useStudio.getState().dirty && !useSignIn.getState().redirecting) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    const unstash = onBeforeSignIn(stashUnsaved);
    return () => {
      window.removeEventListener("beforeunload", warn);
      unstash();
    };
  }, []);

  return save;
}

/**
 * Studio-wide `studio.core` commands. Renderers register at a higher priority and so run
 * first; anything they decline (e.g. Escape with no shape in progress) falls through here.
 */
function useStudioShortcuts(env: ResolvedEnv, items: StudioItem[], showShortcuts: () => void) {
  const s = useStudio.getState;
  const itemCount = items.length;
  const labels = regionLabelNames(env.labels);
  const classes = labelClasses(env.labels);
  const resizeBrush = (factor: number) => {
    const st = s();
    const size = brushSizeOf(st);
    st.setToolOption(st.tool, "size", Math.max(2, Math.min(120, Math.round(size * factor))));
  };
  // Sliders and tabs own their arrow keys.
  const ownsArrows = (e: KeyboardEvent) => e.target instanceof Element && !!e.target.closest('[role="slider"],[role="tab"]');

  useCommands(
    {
      undo: () => s().undo(),
      redo: () => s().redo(),
      deselect: () => {
        if (!s().selectedIds.length) return false;
        s().select(null);
      },
      deleteSelection: () => {
        const { selectedIds, annotations, lockedLabels, removeMany } = s();
        const chosen = annotations.filter((x) => selectedIds.includes(x.id));
        if (!chosen.length) return false;
        removeMany(chosen.filter((a) => isEditable(a, lockedLabels)).map((a) => a.id));
      },
      selectAll: () => {
        const { annotations, itemIndex, hiddenLabels, selectMany } = s();
        const item = items[itemIndex];
        if (!item) return false;
        selectMany(visibleFor(annotations, item.id, hiddenLabels).filter((a) => a.geometry.type !== "class").map((a) => a.id));
      },
      brushSmaller: () => resizeBrush(0.8),
      brushLarger: () => resizeBrush(1.25),
      nextItem: (e) => {
        if (ownsArrows(e)) return false;
        s().setItemIndex(Math.min(itemCount - 1, s().itemIndex + 1));
      },
      prevItem: (e) => {
        if (ownsArrows(e)) return false;
        s().setItemIndex(Math.max(0, s().itemIndex - 1));
      },
      nextTodo: () => {
        const next = nextTodoIndex(items, s().annotations, s().itemIndex);
        if (next === undefined) return false;
        s().setItemIndex(next);
      },
      pickLabel: (e) => {
        const label = labels[(digitOf(e) ?? 0) - 1];
        // A class with its own hotkey isn't also picked by position.
        if (!label || classes.find((c) => c.id === label)?.hotkey) return false;
        s().setActiveLabel(label);
      },
      showShortcuts,
      toggleSidePanel: () => useShell.getState().toggleStudioLeft(),
    },
    { priority: SHELL_PRIORITY, scope: ns("core") },
  );

  // Tool and label-class hotkeys come from their contributions.
  useHotkeys((e) => {
    const t = env.tools.find((x) => x.hotkey && matches(e, x.hotkey));
    if (t) {
      if (!e.repeat) {
        s().setTool(t.name);
        // Pressing J makes Cobb angle the face of the Measure button (todo8 D4).
        rememberTool(env.id, t);
      }
      return true;
    }
    const c = classes.find((x) => x.hotkey && matches(e, x.hotkey));
    if (c) {
      s().setActiveLabel(c.id);
      return true;
    }
    return false;
  }, SHELL_PRIORITY);
}
