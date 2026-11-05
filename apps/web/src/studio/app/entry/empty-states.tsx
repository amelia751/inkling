import { useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { NAMING } from "@studio/contracts/naming";
import { AddDataIcon, AiIcon, FolderIcon, PlusIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { ComposerEmptyState, type ComposerFiles } from "@studio/ui/ui/composer-empty-state";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { cn } from "@studio/ui/utils";
import { kernelEnabled } from "@/extension-host/kernel";
import { startTimeline, type TimelineOrigin } from "@/studio/lib/drop-timeline";
import { useProjectSummary } from "@/studio/lib/projects-api";
import { useShell } from "@/studio/stores/shell";
import { useStudio } from "@/studio/stores/studio";
import { pickedFrom, useDropFiles, type DropOrigin } from "./drop-adapter";
import type { Picked } from "@/studio/lib/uploads/walk";
import { usePendingAsks } from "./pending-ask";
import { feature } from "@/studio/lib/features";
import { newDropId } from "@/studio/core/drops/api";
import { AttachmentTiles } from "@/studio/core/drops/attachment-tiles";
import { cancelDrop } from "@/studio/core/drops/start";
import { useComposerAttachments } from "./composer-attachments";
import { useAgent } from "@/studio/stores/agent";
import { AiNotice, useAckAiNotice } from "@/studio/components/ai/ai-notice";
import { emptyProjectCopy } from "@/studio/components/ai/empty-project-copy";

/**
 * The empty states of todo13 §3.1. The project Overview keeps the composer; the Studio entry and
 * an empty Studio are a blank canvas (one "+" tile); Files and Datasets are the standard
 * `EmptyState` over a silent drop target. Copy and test ids follow the §3.1 table; the old ids stay where tests use them
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

/**
 * Files dropped or attached in an empty project's chat (its Overview composer, or anywhere on the
 * empty page) are attached to that composer: the upload starts at once (with chat drops on, as a
 * drop shared in the project's conversation; otherwise through the tray), but nothing is sent.
 * todo29 D1: attaching never sends; Send (`useSendWithAttachments`) carries the files.
 */
export function useChatDrop(projectId: string) {
  const drop = useDropFiles();
  return async (picked: Picked, timelineStarted = false) => {
    if (!timelineStarted) startTimeline("overview");
    if (!picked.files.length) return;
    const { attach, byProject } = useComposerAttachments.getState();
    if (feature("chatDrops")) {
      const conv = await useAgent.getState().ensureConversation(projectId);
      // More files before Send join the same drop.
      const pending = byProject[projectId]?.drop ?? { dropId: newDropId(), messageId: crypto.randomUUID() };
      attach(projectId, { drop: pending });
      await drop({ projectId, picked, origin: "chat", surface: "overview", timelineStarted: true, conversationId: conv.id, conversationTitle: conv.title ?? undefined, ...pending });
      return;
    }
    await drop({ projectId, picked, origin: "files", surface: "overview", timelineStarted: true, onUploadKey: (key) => attach(projectId, { uploadKey: key }) });
  };
}

/**
 * Send from the empty Overview composer: the text and whatever is attached go to the drawer's
 * conversation (queued until it's ready), and the drawer opens now, not on the drop.
 */
export function useSendWithAttachments(projectId: string) {
  const setAssistant = useShell((s) => s.setAssistant);
  const queue = usePendingAsks((s) => s.queue);
  return (text: string) => {
    const t = text.trim();
    const a = useComposerAttachments.getState().take(projectId);
    if (!t && !a?.drop && !a?.uploadKey) return;
    startTimeline("send");
    queue(projectId, t, a?.drop, a?.uploadKey ? { key: a.uploadKey } : undefined);
    setAssistant(true, true);
  };
}

function useChatFiles(projectId: string) {
  const attach = useChatDrop(projectId);
  return async (files: ComposerFiles) => {
    startTimeline("overview");
    await attach(await pickedFrom(files), true);
  };
}

/** The empty composer's attached files, as tiles (chat drops on) or the tray's line (off). */
function EmptyComposerAttachments({ projectId }: { projectId: string }) {
  const a = useComposerAttachments((s) => s.byProject[projectId]);
  if (!a?.drop) return null;
  return <AttachmentTiles dropId={a.drop.dropId} projectId={projectId} variant="composer" onCancel={() => (void cancelDrop(a.drop!.dropId), useComposerAttachments.getState().clear(projectId))} />;
}

/** Overview of a project with nothing in it yet: only the chat with the assistant. */
export function ProjectEmptyState({ projectId, title }: { projectId: string; title: string }) {
  const attachFiles = useChatFiles(projectId);
  const send = useSendWithAttachments(projectId);
  const ackAiNotice = useAckAiNotice();
  const blocked = useFilesBlocked(projectId);
  const [text, setText] = useState("");
  const attached = useComposerAttachments((s) => !!s.byProject[projectId]);
  const panelOpen = useShell((s) => s.assistantOpen);
  const copy = emptyProjectCopy(title);
  if (panelOpen)
    return (
      <EmptyState
        variant="page"
        art="files"
        title="No files yet"
        description={`Attach them in the ${NAMING.displayName} panel, or drop them anywhere here.`}
        className="py-16"
        data-testid="empty-project"
      />
    );
  return (
    <div className="flex flex-col gap-2" data-testid="empty-project">
      <ComposerEmptyState
        variant="page"
        composer
        title={copy.title}
        description={copy.description}
        placeholder={`“${copy.example}”`}
        value={text}
        onValueChange={setText}
        onSend={(t) => (ackAiNotice(), send(t), setText(""))}
        attachments={attached ? <EmptyComposerAttachments projectId={projectId} /> : undefined}
        onFiles={(f) => (ackAiNotice(), void attachFiles(f))}
        filesDisabledReason={blocked}
        dropLabel={`Drop to add these files to ${title}`}
        footnote={<AiNotice />}
        autoFocus
        dropTestId="drop-zone"
        inputTestId="empty-project-input"
        className="py-8"
      />
    </div>
  );
}

/** Files dropped on a surface: the whole area takes a file drag and lights up while it's over. */
function useDropArea(onFiles: (files: ComposerFiles) => void, enabled: boolean) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const isFiles = (dt: DataTransfer | null) => !!dt && [...dt.types].includes("Files");
  const props = {
    onDragEnter: (e: DragEvent) => {
      if (!enabled || !isFiles(e.dataTransfer)) return;
      depth.current++;
      setOver(true);
    },
    onDragLeave: () => {
      if (--depth.current <= 0) {
        depth.current = 0;
        setOver(false);
      }
    },
    onDragOver: (e: DragEvent) => {
      if (enabled && isFiles(e.dataTransfer)) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      if (!enabled || !isFiles(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current = 0;
      setOver(false);
      onFiles(e.dataTransfer);
    },
  };
  return { over, props };
}

function DropOverlay({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-ring bg-background/80" aria-hidden>
      <span className="flex items-center gap-2 rounded-lg bg-float px-3 py-2 text-sm font-medium shadow-float-lg">
        <AddDataIcon className="size-4" /> {label}
      </span>
    </div>
  );
}

/** The hidden file and folder inputs (`pick-files`, `pick-folder`: tests set files on them). */
function usePickers(onFiles: (files: ComposerFiles) => void, enabled: boolean) {
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const take = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length && enabled) onFiles(e.target.files);
    e.target.value = "";
  };
  const inputs = (
    <>
      <input ref={fileRef} type="file" multiple hidden onChange={take} data-testid="pick-files" />
      <input ref={dirRef} type="file" multiple hidden onChange={take} data-testid="pick-folder" {...{ webkitdirectory: "", directory: "" }} />
    </>
  );
  return { inputs, pickFiles: () => fileRef.current?.click(), pickFolder: () => dirRef.current?.click() };
}

/** "Add files" with the files-or-folder choice. */
function AddFilesButton({ pickFiles, pickFolder, disabledReason }: { pickFiles: () => void; pickFolder: () => void; disabledReason?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="lg" disabled={!!disabledReason} title={disabledReason} data-testid="composer-add-files">
          <AddDataIcon /> Add files
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center">
        <DropdownMenuItem onSelect={pickFiles}>
          <AddDataIcon /> Files…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={pickFolder}>
          <FolderIcon /> Folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A quiet dotted grid, like a fresh design or workflow canvas. */
const DOTS: CSSProperties = {
  backgroundImage: "radial-gradient(var(--color-border-hover) 1px, transparent 1.2px)",
  backgroundSize: "20px 20px",
  backgroundPosition: "-10px -10px",
};

/**
 * A blank canvas (Studio entry, an empty Studio): dotted grid, one dashed "+" tile in the middle
 * that opens the file picker, one line under it and a quiet link to the assistant. The whole
 * canvas takes a file drop.
 */
function BlankCanvas({
  onFiles,
  blocked,
  label,
  onAsk,
  askLabel,
  dropLabel,
  testId,
  className,
}: {
  onFiles: (files: ComposerFiles) => void;
  blocked?: string;
  label: string;
  onAsk?: () => void;
  askLabel: string;
  dropLabel: string;
  testId: string;
  className?: string;
}) {
  const { over, props } = useDropArea(onFiles, !blocked);
  const { inputs, pickFiles } = usePickers(onFiles, !blocked);
  return (
    <div className={cn("relative flex h-full min-h-[360px] w-full flex-col items-center justify-center gap-4 rounded-xl border border-border bg-background p-6 text-center", className)} style={DOTS} data-testid={testId} {...props}>
      {inputs}
      <button
        type="button"
        onClick={pickFiles}
        disabled={!!blocked}
        title={blocked ?? label}
        aria-label={label}
        className="flex size-28 items-center justify-center rounded-2xl border-2 border-dashed border-border-hover bg-background text-muted-foreground transition-colors hover:border-ring hover:text-foreground focus-visible:border-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        data-testid="drop-zone"
      >
        <PlusIcon className="size-8" />
      </button>
      <div className="flex flex-col items-center gap-1.5">
        <p className="text-sm font-medium">{blocked ?? label}</p>
        {onAsk && (
          <button type="button" onClick={onAsk} className="text-sm text-muted-foreground hover:text-foreground hover:underline" data-testid="composer-ask">
            {askLabel}
          </button>
        )}
      </div>
      {over && <DropOverlay label={dropLabel} />}
    </div>
  );
}

/** The drive with nothing in it (Files' root). */
export function FilesEmptyState({ projectId, disabledReason }: { projectId: string; disabledReason?: string | null }) {
  const onFiles = useEntryFiles(projectId, "files", "files");
  const blocked = disabledReason ?? undefined;
  const { over, props } = useDropArea((f) => void onFiles(f), !blocked);
  const { inputs, pickFiles, pickFolder } = usePickers((f) => void onFiles(f), !blocked);
  return (
    <div className="relative flex min-h-[420px] w-full" data-testid="files-empty" {...props}>
      {inputs}
      <EmptyState
        variant="page"
        art="files"
        title="No files yet"
        description={blocked ?? "Drop files or folders anywhere here."}
        actions={<AddFilesButton pickFiles={pickFiles} pickFolder={pickFolder} disabledReason={blocked} />}
        data-testid="drop-zone"
      />
      {over && <DropOverlay label="Drop to add these files" />}
    </div>
  );
}

/** Datasets with none yet (the datasets workstream builds the full landing around it). */
export function DatasetsEmptyState({ projectId, actions }: { projectId: string; actions?: ReactNode }) {
  const onFiles = useEntryFiles(projectId, "files", "datasets");
  const ask = useAskInDrawer(projectId);
  const blocked = useFilesBlocked(projectId);
  const { over, props } = useDropArea((f) => void onFiles(f), !blocked);
  return (
    <div className="relative flex min-h-[420px] w-full" data-testid="datasets-empty" {...props}>
      <EmptyState
        variant="page"
        art="dataset"
        title="No datasets yet"
        description="Datasets appear when you add data."
        actions={
          <>
            {actions}
            <Button type="button" variant="ghost" size="lg" onClick={() => ask()} data-testid="composer-ask">
              <AiIcon className="text-ai-text" /> Ask the assistant
            </Button>
          </>
        }
      />
      {over && <DropOverlay label="Drop to add these files" />}
    </div>
  );
}

/** The Studio entry of a project with no Studio (task) yet: a blank canvas. */
export function StudioEntryEmptyState({ projectId }: { projectId: string }) {
  const onFiles = useEntryFiles(projectId, "studio", "studio");
  const ask = useAskInDrawer(projectId);
  const blocked = useFilesBlocked(projectId);
  return (
    <BlankCanvas
      onFiles={(f) => void onFiles(f)}
      blocked={blocked}
      label="Add data to open a Studio"
      onAsk={() => ask()}
      askLabel="or describe it to the assistant"
      dropLabel="Drop to start a Studio with these files"
      testId="studio-empty"
    />
  );
}

/**
 * The Studio canvas with no item (todo13 D11): a blank canvas whose drop adds the files to this
 * Studio's task (same-kind files become items live, todo11), and the way to the chat.
 */
export function CanvasEmptyState({ projectId, taskId }: { projectId: string; taskId: string }) {
  const onFiles = useEntryFiles(projectId, "studio", "canvas", taskId);
  const toggleAi = useStudio((s) => s.toggleAi);
  const aiOpen = useStudio((s) => s.aiOpen);
  const blocked = useFilesBlocked(projectId);
  return (
    <BlankCanvas
      onFiles={(f) => void onFiles(f)}
      blocked={blocked}
      label="Add files"
      onAsk={aiOpen ? undefined : toggleAi}
      askLabel="or ask the assistant"
      dropLabel="Drop to add these files to this Studio"
      testId="studio-canvas-empty"
      className="rounded-none border-0"
    />
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
