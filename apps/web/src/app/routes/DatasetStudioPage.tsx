import { useCallback, useEffect, useMemo, useRef } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AiAssistantPanel } from "@/components/studio/AiAssistantPanel";
import { CanvasStatusBar } from "@/components/studio/CanvasStatusBar";
import { CanvasToolbar, TOOL_META } from "@/components/studio/CanvasToolbar";
import { LeftSidebar } from "@/components/studio/LeftSidebar";
import { StudioTopBar } from "@/components/studio/StudioTopBar";
import { fetchAnnotations, saveAnnotations } from "@/lib/api";
import { projectItems } from "@/lib/items";
import { useStudio, type Tool } from "@/stores/studio";
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
  const save = useAutosave(projectId);
  useStudioShortcuts(items.length, adapter?.tools ?? [], project?.labels ?? []);

  // Open on a tool this viewer actually offers (whole-slide starts in pan, not select).
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  useEffect(() => {
    if (adapter && !adapter.tools.includes(tool)) setTool(adapter.tools[0]);
  }, [adapter, tool, setTool]);

  if (!project) return null;
  const item = items[itemIndex];

  return (
    <div className="flex h-full flex-col">
      <StudioTopBar project={project} onRetrySave={save} />
      <PanelGroup direction="horizontal" autoSaveId="inkling-studio" className="min-h-0 flex-1">
        <Panel id="left" order={1} defaultSize={20} minSize={14} maxSize={30} collapsible className="border-r border-[var(--border-color)]">
          <LeftSidebar project={project} items={items} />
        </Panel>
        <PanelResizeHandle className="w-px bg-[var(--border-color)] transition-colors hover:bg-primary data-[resize-handle-state=drag]:bg-primary" />
        <Panel id="canvas" order={2} minSize={40} className="flex flex-col">
          {adapter && <CanvasToolbar project={project} tools={adapter.tools} />}
          <main className="min-h-0 flex-1" aria-label="Viewer">
            {adapter && item ? (
              <adapter.Component project={project} item={item} />
            ) : (
              <FullPageMessage title="No viewer for this data type yet" body="This project's format is planned for a later phase." />
            )}
          </main>
          <CanvasStatusBar items={items} />
        </Panel>
        {aiOpen && (
          <>
            <PanelResizeHandle className="w-px bg-[var(--border-color)] transition-colors hover:bg-primary" />
            <Panel id="ai" order={3} defaultSize={24} minSize={18} maxSize={32} className="border-l border-[var(--border-color)]">
              <AiAssistantPanel project={project} item={item} />
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  );
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

function useStudioShortcuts(itemCount: number, tools: Tool[], labels: string[]) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // Sliders and tabs own their arrow keys.
      if (e.key.startsWith("Arrow") && (e.target as HTMLElement).closest?.('[role="slider"],[role="tab"]')) return;
      const s = useStudio.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") s.setItemIndex(Math.min(itemCount - 1, s.itemIndex + 1));
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") s.setItemIndex(Math.max(0, s.itemIndex - 1));
      else if (/^[1-9]$/.test(e.key) && labels[+e.key - 1]) s.setActiveLabel(labels[+e.key - 1]);
      else {
        const tool = tools.find((t) => TOOL_META[t].key.toLowerCase() === e.key.toLowerCase());
        if (tool) s.setTool(tool);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [itemCount, tools, labels]);
}
