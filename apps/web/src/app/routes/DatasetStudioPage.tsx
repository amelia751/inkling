import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AiAssistantPanel } from "@/components/studio/AiAssistantPanel";
import { CanvasStatusBar } from "@/components/studio/CanvasStatusBar";
import { CanvasToolbar } from "@/components/studio/CanvasToolbar";
import { LeftSidebar } from "@/components/studio/LeftSidebar";
import { StudioTopBar } from "@/components/studio/StudioTopBar";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useViewport, useWindowWidth } from "@/lib/use-media-query";
import { fetchAnnotations, saveAnnotations } from "@/lib/api";
import { digitOf, matches, SHELL_PRIORITY, useHotkeys, useShortcuts } from "@/lib/hotkeys";
import { findConflicts, TOOL_KEYS } from "@/lib/shortcuts";
import { ShortcutsDialog } from "@/components/studio/ShortcutsDialog";
import { projectItems } from "@/lib/items";
import { isEditable, useStudio, visibleFor, type Tool } from "@/stores/studio";
import type { StudioItem } from "@/types";
import { adapterFor } from "@/viewers/registry";
import { FullPageMessage, useProject } from "./shared";

const AUTOSAVE_MS = 800;

export function DatasetStudioPage() {
  const { datasetId = "" } = useParams();
  const { project, isLoading, error } = useProject(datasetId);
  const saved = useQuery({ queryKey: ["annotations", datasetId], queryFn: () => fetchAnnotations(datasetId), enabled: !!project, staleTime: Infinity });
  const projectId = useStudio((s) => s.projectId);
  const load = useStudio((s) => s.load);

  useEffect(() => {
    if (project && saved.data && projectId !== project.id) {
      load(project.id, saved.data.annotations, saved.data.revision, project.labels?.[0] ?? null);
    }
  }, [project, saved.data, projectId, load]);

  if (isLoading || saved.isLoading) return <FullPageMessage title="Opening Studio…" />;
  if (error || !project) return <FullPageMessage title="Dataset not found" body={`No seed project “${datasetId}”. Run pnpm seeds, then reload.`} />;
  if (saved.error) return <FullPageMessage title="Couldn't load annotations" body={String(saved.error)} />;
  if (projectId !== project.id) return <FullPageMessage title="Opening Studio…" />;
  return <Studio key={project.id} projectId={project.id} />;
}

function Studio({ projectId }: { projectId: string }) {
  const { project } = useProject(projectId);
  const items = useMemo(() => (project ? projectItems(project) : []), [project]);
  const adapter = project ? adapterFor(project) : undefined;
  const itemIndex = useStudio((s) => s.itemIndex);
  const aiOpen = useStudio((s) => s.aiOpen);
  const toggleAi = useStudio((s) => s.toggleAi);
  const save = useAutosave(projectId);
  const viewport = useViewport();
  const width = useWindowWidth();
  /** Panel sizes are percentages; convert pixel targets so panels keep usable widths at any window size. */
  const pct = (px: number) => Math.min(100, (px / width) * 100);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Picking a file in the phone drawer should reveal the canvas.
  useEffect(() => setSidebarOpen(false), [itemIndex]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useStudioShortcuts(items, adapter?.tools ?? [], project?.labels ?? [], () => setShortcutsOpen(true));
  useEffect(() => {
    if (import.meta.env.DEV && project && adapter) findConflicts(project.viewer, adapter.tools).forEach((c) => console.warn(`[shortcuts] ${c}`));
  }, [project, adapter]);

  // Open on a tool this viewer actually offers (whole-slide starts in pan, not select).
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  useEffect(() => {
    if (adapter && !adapter.tools.includes(tool)) setTool(adapter.tools[0]);
  }, [adapter, tool, setTool]);

  if (!project) return null;
  const item = items[itemIndex];

  const canvas = (
    <>
      {adapter && <CanvasToolbar project={project} tools={adapter.tools} />}
      <main className="min-h-0 flex-1" aria-label="Viewer">
        {adapter && item ? (
          <Suspense fallback={<FullPageMessage title="Loading viewer…" />}>
            <adapter.Component key={item.id} project={project} item={item} />
          </Suspense>
        ) : (
          <FullPageMessage title="No viewer for this data type yet" body="This project's format is planned for a later phase." />
        )}
      </main>
      <CanvasStatusBar items={items} />
    </>
  );

  return (
    <div className="flex h-full flex-col">
      <StudioTopBar
        project={project}
        onRetrySave={save}
        onOpenSidebar={viewport === "phone" ? () => setSidebarOpen(true) : undefined}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} viewer={project.viewer} tools={adapter?.tools ?? []} />
      {viewport === "phone" ? (
        <div className="flex min-h-0 flex-1 flex-col">{canvas}</div>
      ) : (
        <PanelGroup direction="horizontal" autoSaveId={`inkling-studio-${viewport}`} className="min-h-0 flex-1">
          <Panel id="left" order={1} defaultSize={pct(280)} minSize={pct(240)} maxSize={pct(420)}>
            <LeftSidebar project={project} items={items} />
          </Panel>
          <ResizeHandle />
          <Panel id="canvas" order={2} minSize={pct(360)} className="flex flex-col">
            {canvas}
          </Panel>
          {aiOpen && viewport === "desktop" && (
            <>
              <ResizeHandle />
              <Panel id="ai" order={3} defaultSize={pct(340)} minSize={pct(300)} maxSize={pct(480)}>
                <AiAssistantPanel project={project} item={item} />
              </Panel>
            </>
          )}
        </PanelGroup>
      )}

      {viewport === "phone" && (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" title="Files, labels and review" showClose={false}>
            <LeftSidebar project={project} items={items} />
          </SheetContent>
        </Sheet>
      )}
      {viewport !== "desktop" && (
        <Sheet open={aiOpen} onOpenChange={(open) => open !== aiOpen && toggleAi()}>
          <SheetContent side="right" title="Inkling AI" showClose={false}>
            <AiAssistantPanel project={project} item={item} />
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function ResizeHandle() {
  return <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary data-[resize-handle-state=drag]:bg-primary" />;
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
        const doc = await saveAnnotations(projectId, { revision: s.revision, annotations: snapshot });
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
 * Studio-wide shortcuts. Viewers register at a higher priority and so run first;
 * anything they decline (e.g. Escape with no shape in progress) falls through to here.
 */
function useStudioShortcuts(items: StudioItem[], tools: Tool[], labels: string[], showShortcuts: () => void) {
  const s = useStudio.getState;
  const itemCount = items.length;
  const resizeBrush = (factor: number) => {
    const size = s().toolOptions.brushSize;
    s().setToolOptions({ brushSize: Math.max(2, Math.min(120, Math.round(size * factor))) });
  };
  // Sliders and tabs own their arrow keys.
  const ownsArrows = (e: KeyboardEvent) => e.target instanceof Element && !!e.target.closest('[role="slider"],[role="tab"]');

  useShortcuts(
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
        if (!label) return false;
        s().setActiveLabel(label);
      },
      showShortcuts,
    },
    { priority: SHELL_PRIORITY },
  );

  useHotkeys((e) => {
    const tool = tools.find((t) => matches(e, TOOL_KEYS[t]));
    if (!tool) return false;
    if (!e.repeat) s().setTool(tool);
    return true;
  }, SHELL_PRIORITY);
}
