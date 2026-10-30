import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CanvasStatusBar } from "@/studio/components/studio/CanvasStatusBar";
import { CanvasToolbar } from "@/studio/components/studio/CanvasToolbar";
import { LeftSidebar, SlotTabs } from "@/studio/components/studio/LeftSidebar";
import { StudioLayout } from "@/studio/components/studio/StudioLayout";
import { StudioTopBar } from "@/studio/components/studio/StudioTopBar";
import { ShortcutsDialog } from "@/studio/components/studio/ShortcutsDialog";
import { ViewportHost } from "@/studio/components/studio/ViewportHost";
import { Sheet, SheetContent } from "@studio/studio-ui/ui/sheet";
import { useViewport } from "@/studio/lib/use-media-query";
import { fetchAnnotations, fetchEnvironment, saveAnnotations } from "@/studio/lib/api";
import { setLabelClasses } from "@studio/plugin-ui-sdk/labels";
import { ANNOTATIONS_VERSION } from "@studio/plugin-contracts/migrations/annotations-v1-to-v2";
import { setActiveCommands, SHELL_PRIORITY, useCommands, useHotkeys } from "@/extension-host/commands";
import { labelClasses, regionLabelNames } from "@studio/plugin-contracts/environment";
import { digitOf, matches } from "@studio/studio-ui/keys";
import { registry } from "@/extension-host/registry";
import { applyWorkspace, fetchWorkspaceState } from "@/extension-host/workspace";
import { prepareAssetUrls } from "@/extension-host/kernel";
import { bindDeclarativeCommands, itemMediaType } from "@/extension-host/contributions-loader";
import { resolveEnvironment, type EnvError, type ResolvedEnv } from "@/extension-host/resolve";
import { clearRuntime, publish } from "@studio/plugin-ui-sdk/runtime";
import { brushSizeOf, isEditable, useStudio, visibleFor } from "@/studio/stores/studio";
import type { Project, StudioItem } from "@studio/plugin-contracts/types";
import { FullPageMessage, useProject } from "./shared";
import { NAMING, RES, ns } from "@studio/plugin-contracts/naming";

const AUTOSAVE_MS = 800;
// The schema form library only loads when the settings dialog opens.
const ModuleConfigDialog = lazy(() => import("@/studio/components/studio/ModuleConfigForm").then((m) => ({ default: m.ModuleConfigDialog })));
const LEGACY_TYPES = /^(interval|beat|wave|rhythm|phase|segment|event|mark|point)$/;

type Boot = { status: "loading" } | { status: "errors"; errors: EnvError[] } | { status: "failed"; message: string } | { status: "ready"; env: ResolvedEnv };

/**
 * Resolve the project's environment (its saved edits, else the manifest's) and load the
 * implementations of every module it uses, so renderers and panels mount synchronously.
 */
function useEnvironment(project: Project | undefined): Boot {
  const saved = useQuery({ queryKey: ["environment", project?.id], queryFn: () => fetchEnvironment(project!.id).catch(() => null), enabled: !!project, staleTime: Infinity });
  // The workspace's active plugins (kernel Workspace API; in dev seed-data/<project>/workspace.json).
  const workspace = useQuery({
    queryKey: ["workspace", project?.id],
    queryFn: async () => {
      await prepareAssetUrls(project!.id);
      return fetchWorkspaceState(project!.id);
    },
    enabled: !!project,
    staleTime: Infinity,
  });
  const [boot, setBoot] = useState<Boot>({ status: "loading" });
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (workspace.isLoading || workspace.error) return;
    applyWorkspace(workspace.data ?? null);
    setApplied(true);
  }, [workspace.isLoading, workspace.error, workspace.data]);
  // Re-resolve when plugins are enabled or disabled (e.g. enabling one this environment needs).
  const activation = useSyncExternalStore((l) => registry.subscribe(l), () => registry.activationVersion);
  useEffect(() => {
    if (workspace.error) return setBoot({ status: "failed", message: String(workspace.error) });
    if (!project || saved.isLoading || !applied) return;
    const spec = saved.data?.environment ?? project.environment;
    const r = resolveEnvironment(spec, registry);
    if (r.errors) return setBoot({ status: "errors", errors: r.errors });
    let live = true;
    Promise.all(r.env.modules.map((m) => registry.preload(m.id)))
      .then(() => live && setBoot({ status: "ready", env: r.env }))
      .catch((e) => live && setBoot({ status: "failed", message: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [project, saved.isLoading, saved.data, applied, activation, workspace.error]);
  return boot;
}

export function DatasetStudioPage() {
  const { datasetId = "" } = useParams();
  const { project, isLoading, error } = useProject(datasetId);
  const saved = useQuery({ queryKey: ["annotations", datasetId], queryFn: () => fetchAnnotations(datasetId), enabled: !!project, staleTime: Infinity });
  const boot = useEnvironment(project);
  const projectId = useStudio((s) => s.projectId);
  const load = useStudio((s) => s.load);
  const setEnv = useStudio((s) => s.setEnv);

  useEffect(() => {
    if (project && saved.data && boot.status === "ready" && projectId !== project.id) {
      clearRuntime();
      setEnv(boot.env, { record: false });
      load(project.id, saved.data.annotations, saved.data.revision, regionLabelNames(boot.env.labels)[0] ?? null);
    }
  }, [project, saved.data, projectId, load, boot, setEnv]);

  if (isLoading || saved.isLoading) return <FullPageMessage title="Opening Studio…" loading />;
  if (error || !project) return <FullPageMessage title="Dataset not found" body={`No seed project “${datasetId}”. Run pnpm seeds, then reload.`} />;
  if (saved.error) return <FullPageMessage title="Couldn't load annotations" body={String(saved.error)} />;
  if (boot.status === "errors") return <EnvErrors errors={boot.errors} />;
  if (boot.status === "failed") return <FullPageMessage title="Couldn't load this environment's modules" body={boot.message} />;
  if (boot.status === "loading" || projectId !== project.id) return <FullPageMessage title="Opening Studio…" loading />;
  return <Studio key={project.id} projectId={project.id} />;
}

/** Resolver errors, with the JSON Pointer of each problem so the spec can be fixed. */
function EnvErrors({ errors }: { errors: EnvError[] }) {
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
    </div>
  );
}

function Studio({ projectId }: { projectId: string }) {
  const { project } = useProject(projectId);
  const env = useStudio((s) => s.env)!;
  const items = useMemo(() => (project ? env.dataKind.groupItems(project) : []), [project, env.dataKind]);
  const itemIndex = useStudio((s) => s.itemIndex);
  const aiOpen = useStudio((s) => s.aiOpen);
  const toggleAi = useStudio((s) => s.toggleAi);
  const save = useAutosave(projectId);
  const viewport = useViewport();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Picking a file in the phone drawer should reveal the canvas.
  useEffect(() => setSidebarOpen(false), [itemIndex]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEnvBindings(env, items);
  useActivationSync(env);
  useStudioShortcuts(env, items, () => setShortcutsOpen(true));

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
          env.viewports.length === 1 ? (
            <ViewportHost key={item.id} env={env} viewport={main} project={project} item={item} />
          ) : (
            // Several viewports (e.g. a video next to its sensor trace) share the item and
            // stay in sync through runtime values such as `playhead`.
            <div className="flex h-full min-h-0 divide-x divide-border">
              {env.viewports.map((vp) => (
                <div key={vp.name} className="min-w-0 flex-1" data-viewport={vp.name}>
                  <ViewportHost key={`${item.id}:${vp.name}`} env={env} viewport={vp} project={project} item={item} />
                </div>
              ))}
            </div>
          )
        ) : (
          <FullPageMessage title="Nothing to annotate" body="This project has no items for its data kind." />
        )}
      </main>
      {bottom}
      <CanvasStatusBar items={items} />
    </>
  );
  const left = <LeftSidebar env={env} project={project} items={items} item={item} />;
  const right = <SlotTabs slot="right" only={rightIds} env={env} project={project} items={items} item={item} />;

  return (
    <div className="flex h-full flex-col">
      <StudioTopBar
        project={project}
        onRetrySave={save}
        onOpenSidebar={viewport === "phone" ? () => setSidebarOpen(true) : undefined}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onShowSettings={() => setSettingsOpen(true)}
        showAi={hasAi || (viewport !== "desktop" && env.panels.right.length > 0)}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} env={env} />
      {settingsOpen && (
        <Suspense fallback={null}>
          <ModuleConfigDialog open onOpenChange={setSettingsOpen} env={env} projectId={projectId} />
        </Suspense>
      )}
      {viewport === "phone" ? (
        <div className="flex min-h-0 flex-1 flex-col">{canvas}</div>
      ) : (
        <StudioLayout
          storageKey={`${RES}-layout-${projectId}-${viewport}`}
          layout={env.spec.layout ?? null}
          slots={{
            viewer: <div className="flex h-full min-h-0 flex-col">{canvas}</div>,
            "slot:left": env.panels.left.length > 0 ? left : null,
            // Below the desktop breakpoint the right slot is a sheet (see below).
            "slot:right": showRight && viewport === "desktop" ? right : null,
            "slot:bottom": bottomPanels,
          }}
        />
      )}

      {viewport === "phone" && (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" title="Files, labels and review" showClose={false}>
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
    let live = true;
    Promise.all(r.env.modules.map((m) => registry.preload(m.id))).then(() => live && useStudio.getState().setEnv(r.env, { record: false }));
    return () => {
      live = false;
    };
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

/** Debounced save; the indicator only shows "Saved" after the server returns the new revision. */
function useAutosave(projectId: string) {
  const annotations = useStudio((s) => s.annotations);
  const dirty = useStudio((s) => s.dirty);
  const inFlight = useRef(false);

  const save = useCallback(async () => {
    const run = async (): Promise<void> => {
      const s = useStudio.getState();
      if (inFlight.current || !s.dirty) return;
      inFlight.current = true;
      const snapshot = s.annotations;
      s.markSaving();
      try {
        const v2 = !snapshot.some((a) => LEGACY_TYPES.test(a.geometry.type));
        const doc = await saveAnnotations(projectId, { revision: s.revision, annotations: snapshot, ...(v2 ? { annotationsVersion: ANNOTATIONS_VERSION } : {}) });
        useStudio.getState().markSaved(doc.revision, snapshot);
      } catch {
        useStudio.getState().markError();
        return;
      } finally {
        inFlight.current = false;
      }
      // Edits made while the request was in flight still need saving.
      if (useStudio.getState().dirty) await run();
    };
    await run();
  }, [projectId]);

  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(save, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [annotations, dirty, save]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (useStudio.getState().dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  return save;
}

/**
 * Studio-wide `inkling.core` commands. Renderers register at a higher priority and so run
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
      pickLabel: (e) => {
        const label = labels[(digitOf(e) ?? 0) - 1];
        // A class with its own hotkey isn't also picked by position.
        if (!label || classes.find((c) => c.id === label)?.hotkey) return false;
        s().setActiveLabel(label);
      },
      showShortcuts,
    },
    { priority: SHELL_PRIORITY, scope: ns("core") },
  );

  // Tool and label-class hotkeys come from their contributions.
  useHotkeys((e) => {
    const t = env.tools.find((x) => x.hotkey && matches(e, x.hotkey));
    if (t) {
      if (!e.repeat) s().setTool(t.name);
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
