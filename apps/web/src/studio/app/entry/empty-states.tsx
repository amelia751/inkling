import { useState, type ReactNode } from "react";
import { NAMING } from "@studio/contracts/naming";
import { AiIcon } from "@studio/ui/icons";
import { ComposerEmptyState, type ComposerFiles } from "@studio/ui/ui/composer-empty-state";
import { kernelEnabled } from "@/extension-host/kernel";
import { startTimeline, type TimelineOrigin } from "@/studio/lib/drop-timeline";
import { useProjectSummary } from "@/studio/lib/projects-api";
import { useShell } from "@/studio/stores/shell";
import { useStudio } from "@/studio/stores/studio";
import { pickedFrom, useDropFiles, type DropOrigin } from "./drop-adapter";
import { usePendingAsks } from "./pending-ask";

/**
 * The empty states of todo13 §3.1, every one a `ComposerEmptyState` (one way in, principle 1).
 * Each says what will appear there and offers the composer's two actions: drop files, or ask
 * the assistant. Copy and test ids follow the §3.1 table; the old ids stay where tests use them
 * (`empty-project`, `tell-assistant`, `drop-zone`, `pick-files`, `pick-folder`).
 */

/** Adding files needs the api (the seed stand-in is read-only). */
const NEEDS_API = "Adding files needs the full stack: see docs/running.md";
/** Dropping is a write (D14): viewers see why they can't. */
const VIEWER = "Ask a contributor to add files";

/** Why files can't be added here, or undefined when they can. */
function useFilesBlocked(projectId: string): string | undefined {
  const role = useProjectSummary(projectId).data?.role;
  if (!kernelEnabled()) return NEEDS_API;
  return role === "viewer" ? VIEWER : undefined;
}

/** Files dropped or picked on an entry surface go to the project through the drop adapter. */
function useEntryFiles(projectId: string, origin: DropOrigin, surface: TimelineOrigin, taskId?: string) {
  const drop = useDropFiles();
  return async (files: ComposerFiles) => {
    startTimeline(surface);
    const picked = await pickedFrom(files);
    if (picked.files.length) await drop({ projectId, picked, origin, surface, taskId, timelineStarted: true });
  };
}

/** Open the project drawer and hand it a message (sent once the conversation is ready). */
function useAskInDrawer(projectId: string) {
  const setAssistant = useShell((s) => s.setAssistant);
  const queue = usePendingAsks((s) => s.queue);
  return (text?: string) => {
    if (text?.trim()) {
      startTimeline("send");
      queue(projectId, text.trim());
    }
    setAssistant(true, true);
  };
}

/** Overview of a project with nothing in it yet. */
export function ProjectEmptyState({ projectId, title }: { projectId: string; title: string }) {
  const onFiles = useEntryFiles(projectId, "files", "overview");
  const ask = useAskInDrawer(projectId);
  const blocked = useFilesBlocked(projectId);
  return (
    <div className="flex flex-col gap-2" data-testid="empty-project">
      <ComposerEmptyState
        variant="page"
        composer
        title="Let's start with your data"
        description="Start by dropping files, or describe what you want to make."
        placeholder="“Outline the liver in these CT series”, or drop files here"
        onSend={(t) => ask(t)}
        onFiles={(f) => void onFiles(f)}
        filesDisabledReason={blocked}
        dropLabel={`Drop to add these files to ${title}`}
        footnote="DICOM folders, images, videos, tables, documents. Originals are kept exactly as they are."
        dropTestId="drop-zone"
        inputTestId="empty-project-input"
        className="py-8"
      />
      <button type="button" onClick={() => ask()} className="self-center text-sm text-muted-foreground hover:text-foreground" data-testid="tell-assistant">
        <AiIcon className="mr-1.5 inline size-3.5 text-ai-text" />
        Or open the assistant and tell {NAMING.displayName} what you're trying to create
      </button>
    </div>
  );
}

/** The drive with nothing in it (Files' root). */
export function FilesEmptyState({ projectId, disabledReason }: { projectId: string; disabledReason?: string | null }) {
  const onFiles = useEntryFiles(projectId, "files", "files");
  const ask = useAskInDrawer(projectId);
  return (
    <ComposerEmptyState
      variant="page"
      title="Add the files you have"
      description="Everything you add or share in chat lives here. Drop a folder as it is: DICOM exports, spreadsheets, videos, PDFs. Originals are kept exactly as they arrive."
      onFiles={(f) => void onFiles(f)}
      filesDisabledReason={disabledReason ?? undefined}
      onAsk={() => ask()}
      filesLabel="Add files"
      dropLabel="Drop to add these files"
      testId="files-empty"
      dropTestId="drop-zone"
    />
  );
}

/** Datasets with none yet (the datasets workstream builds the full landing around it). */
export function DatasetsEmptyState({ projectId, actions }: { projectId: string; actions?: ReactNode }) {
  const onFiles = useEntryFiles(projectId, "files", "datasets");
  const ask = useAskInDrawer(projectId);
  const blocked = useFilesBlocked(projectId);
  return (
    <ComposerEmptyState
      variant="page"
      title="No datasets yet"
      description="Your datasets will appear here once you add data. Drop files, or describe what you need."
      onFiles={(f) => void onFiles(f)}
      filesDisabledReason={blocked}
      onAsk={() => ask()}
      filesLabel="Drop files"
      actions={actions}
      testId="datasets-empty"
    />
  );
}

/** The Studio entry of a project with no Studio (task) yet. */
export function StudioEntryEmptyState({ projectId }: { projectId: string }) {
  const onFiles = useEntryFiles(projectId, "studio", "studio");
  const ask = useAskInDrawer(projectId);
  const blocked = useFilesBlocked(projectId);
  return (
    <ComposerEmptyState
      variant="page"
      composer
      title="No Studio yet"
      description="Drop files or describe your task, and one will open here."
      placeholder="“Classify chest X-rays into five labels”, or drop files here"
      onSend={(t) => ask(t)}
      onFiles={(f) => void onFiles(f)}
      filesDisabledReason={blocked}
      dropLabel="Drop to start a Studio with these files"
      testId="studio-empty"
      inputTestId="studio-empty-input"
    />
  );
}

/**
 * The Studio canvas with no item (todo13 D11): a drop target that adds the files to this
 * Studio's task (same-kind files become items live, todo11), and the way to the chat.
 */
export function CanvasEmptyState({ projectId, taskId }: { projectId: string; taskId: string }) {
  const onFiles = useEntryFiles(projectId, "studio", "canvas", taskId);
  const toggleAi = useStudio((s) => s.toggleAi);
  const aiOpen = useStudio((s) => s.aiOpen);
  const blocked = useFilesBlocked(projectId);
  return (
    <div className="flex h-full items-center justify-center overflow-auto">
      <ComposerEmptyState
        variant="canvas"
        title="Nothing here yet"
        description="Drop files here to start, or ask the assistant."
        onFiles={(f) => void onFiles(f)}
        filesDisabledReason={blocked}
        onAsk={aiOpen ? undefined : toggleAi}
        askLabel="Open the chat"
        filesLabel="Add files"
        dropLabel="Drop to add these files to this Studio"
        testId="studio-canvas-empty"
      />
    </div>
  );
}

/**
 * The canvas as a drop target while it shows an item (D11): files dropped on the viewer join
 * this Studio's task. Only file drags are taken; everything else passes through to the viewer.
 */
export function CanvasDropTarget({ projectId, taskId, children }: { projectId: string; taskId: string; children: ReactNode }) {
  const onFiles = useEntryFiles(projectId, "studio", "canvas", taskId);
  const [over, setOver] = useState(false);
  const blocked = useFilesBlocked(projectId);
  const writable = !blocked;
  const isFiles = (dt: DataTransfer | null) => !!dt && [...dt.types].includes("Files");
  return (
    <div
      className="relative h-full min-h-0"
      data-testid="studio-canvas-drop"
      onDragOver={(e) => {
        if (!writable || !isFiles(e.dataTransfer)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        if (!writable || !isFiles(e.dataTransfer)) return;
        e.preventDefault();
        setOver(false);
        void onFiles(e.dataTransfer);
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-ring bg-background/60" aria-hidden data-testid="studio-canvas-drop-overlay">
          <span className="rounded-lg bg-float px-3 py-2 text-sm font-medium shadow-float-lg">Drop to add these files to this Studio</span>
        </div>
      )}
    </div>
  );
}
