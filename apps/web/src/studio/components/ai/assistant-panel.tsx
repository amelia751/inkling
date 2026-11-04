import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type RefObject, type SVGProps } from "react";
import { DropPlanCards } from "@/studio/core/drops";
import { useQuery } from "@tanstack/react-query";
import { AddDataIcon, AiIcon, AttachIcon, BranchIcon, ChevronDownIcon, ChevronLeftIcon, CloseIcon, DeleteIcon, FolderIcon, MoreIcon, NewChatIcon, RenameIcon, ShowIcon, SidebarIcon, StopIcon, SubmitIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@studio/ui/ui/dropdown-menu";
import { PanelBodySkeleton } from "@/studio/components/studio/ModuleSlot";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { Input } from "@studio/ui/ui/input";
import { Spinner } from "@studio/ui/ui/spinner";
import { toast } from "@studio/ui/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { cn } from "@studio/ui/utils";
import type { AgentStatus, ProfileName } from "@studio/agent-protocol";
import { NAMING, RES } from "@studio/contracts/naming";
import { agentUnavailable, fetchAgentStatus } from "@/studio/lib/agent/client";
import { useAgentContextStore, type AgentContextProvider } from "@/studio/lib/agent/providers";
import { sessionTools } from "@/studio/lib/agent/session";
import { useStudio } from "@/studio/stores/studio";
import { MAX_ANNOTATIONS, snapshotTruncation } from "@/studio/lib/agent/context";
import { chatTitle, selectStreaming, selectThread, useAgent, type ChatMessage, type ChatSummary, type ClientToolOutcome } from "@/studio/stores/agent";
import { useShell } from "@/studio/stores/shell";
import { AssistantMessage, UserMessage } from "./thread";
import { useAckAiNotice, useAiAssistOff } from "./ai-notice";
import { runStudioCommand, STUDIO_COMMAND } from "@/studio/lib/studio-boot";
import { SPECIALIST_LABEL, type StudioCardContext } from "./cards";
import { usePendingAsk, withUploadNote } from "@/studio/app/entry/pending-ask";
import { useDropFiles } from "@/studio/app/entry/drop-adapter";
import { AttachmentTiles, cancelDrop, pastedFiles, SharedFiles, startDrop, useChatDropsEnabled, whenRegistered } from "@/studio/core/drops";
import { runtimeConfig } from "@/extension-host/runtime-config";
import { useProjectSummary } from "@/studio/lib/projects-api";
import { fromDataTransfer, fromFileList, hasFiles, type Picked } from "@/studio/lib/uploads/walk";
import { settledPhase, trayLine, useUploads } from "@/studio/stores/uploads";
import { chatUploadsGate } from "./chat-uploads";

/**
 * The assistant (docs/ux.md §9), shared by its two hosts (todo6 Phase 6): the Studio's right
 * slot (`core/panels/ai.tsx`) and the project shell's `PersistentAgentDrawer`. One thread and
 * one service session per project (`stores/agent.ts`), so the conversation carries across
 * sections; what it can see comes from the section's `AgentContextProvider` and is shown, and
 * removable, in the `ContextIndicator` chip. Every flow works with it closed.
 */

const NO_CHATS: ChatSummary[] = [];

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
export interface Prompt {
  icon: Icon;
  text: string;
}

export interface AssistantProject {
  id: string;
  title: string;
  /** Licence restricts redistribution: shared as structure only outside the Studio. */
  restricted: boolean;
  /** Files held for privacy review; the assistant never sees them. */
  heldFiles?: number;
}

export interface AssistantPanelProps {
  project: AssistantProject;
  /** What the assistant can see right now (the section's provider). */
  provider: AgentContextProvider;
  /** Runs the client tools the agent asks for (cards; in the Studio, environment tools too). */
  runTool: (name: string, input: Record<string, unknown>) => Promise<ClientToolOutcome>;
  onClose: () => void;
  /** The Studio: its cards act on these items. */
  studio?: StudioCardContext;
  /** Undo an environment change from the thread (the Studio). */
  onUndo?: (messageId: string, partId: string) => void;
  /** Composer placeholder for a profile. */
  placeholder: (profile: ProfileName) => string;
  empty: (profile: ProfileName) => { title: string; body: ReactNode; prompts: Prompt[]; footer?: ReactNode };
  /** Called with the snapshot to send when the chip is removed (the Studio: name only). */
  bareSnapshot?: () => ReturnType<NonNullable<AgentContextProvider["snapshot"]>>;
  /** The Studio's task: images dropped in its chat become its items as they arrive (todo11 D8). */
  taskId?: string;
}

/** todo13: what the composer may do with files here. */
interface Attach {
  /** Files can be attached (the full stack). */
  on: boolean;
  /** Chat drops are on (`API_FEATURE_CHAT_DROPS`): files join a drop the message carries. Off, they upload through the tray into Sources and the message waits for them. */
  drops: boolean;
  /** `/features` hasn't answered yet: a skeleton where attach goes (todo15 D5). */
  pending?: boolean;
  /** Contributors and above (D14); viewers see attach disabled with a hint. */
  allowed: boolean;
  onFiles: (files: Picked | File[]) => void;
}

export function AssistantPanel(props: AssistantPanelProps) {
  const { project, onClose } = props;
  const status = useQuery({ queryKey: ["agent-status"], queryFn: fetchAgentStatus, staleTime: 60_000, retry: false });
  const aiOff = useAiAssistOff();
  const thread = useAgent(selectThread(project.id));
  // todo21 D6: runs are per chat; the composer's busy state and Stop are the open chat's.
  const running = useAgent(selectStreaming(project.id));
  const newChat = useAgent((s) => s.newChat);
  const profile = useAgent((s) => s.profile);
  const setProfile = useAgent((s) => s.setProfile);
  const ready = !!status.data?.configured && !aiOff;
  const specialist = profile === "builder" || profile === "coder" ? profile : undefined;
  const [scrolled, setScrolled] = useState(false);
  const [view, setView] = useState<"chat" | "files">("chat");
  const drops = useChatDropsEnabled(project.id);
  const dropsOn = drops.data === true;
  const canEdit = useProjectSummary(project.id).data?.role !== "viewer";
  const conversationId = useAgent((s) => s.conversations[project.id]?.activeSessionId);
  // todo20 D2: the project's chats live on the server; the list and the open thread load from it.
  useEffect(() => {
    if (ready) void useAgent.getState().loadChats(project.id).catch(() => {});
  }, [project.id, ready]);
  const title = view === "files" ? "Shared files" : `${NAMING.displayName} AI`;
  const startChat = () => {
    setView("chat");
    setListOpen(false);
    void newChat(project.id, { restricted: project.restricted });
  };
  // todo21 D3: a rail of chats on the left; under 520 px the title button opens it over the thread.
  const aside = useRef<HTMLElement>(null);
  const narrow = useNarrow(aside, 520);
  const [railOpen, setRailOpen] = useState(() => readRailPref());
  const [listOpen, setListOpen] = useState(false);
  const toggleRail = () => {
    setRailOpen((v) => (writeRailPref(!v), !v));
  };
  const chatView = ready && view === "chat";
  const showRail = chatView && !narrow && railOpen;
  const showOverlay = chatView && narrow && listOpen;
  const pickChat = (id: string) => {
    setView("chat");
    setListOpen(false);
    useAgent.getState().selectChat(project.id, id);
  };

  return (
    <aside ref={aside} className="flex h-full min-w-0 flex-col bg-float" aria-label={`${NAMING.displayName} AI`}>
      <header className={cn("flex shrink-0 items-center gap-2 border-b pt-3 pr-3 pb-2 pl-4", scrolled && ready && thread.length > 0 ? "border-border" : "border-transparent")}>
        {view === "files" ? (
          <Button variant="ghost-secondary" size="icon-sm" className="-ml-1 text-hint" onClick={() => setView("chat")} aria-label="Back to the chat" data-testid="agent-back-to-chat"><ChevronLeftIcon /></Button>
        ) : (
          <AiIcon className="size-4 shrink-0 text-ai-text" />
        )}
        <h2 className="sr-only">{NAMING.displayName} AI</h2>
        {chatView && !narrow && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost-secondary" size="icon-sm" className="-ml-1 text-hint" onClick={toggleRail} aria-label={railOpen ? "Hide chats" : "Show chats"} aria-pressed={railOpen} data-testid="agent-chat-rail-toggle"><SidebarIcon /></Button>
            </TooltipTrigger>
            <TooltipContent>{railOpen ? "Hide chats" : "Show chats"}</TooltipContent>
          </Tooltip>
        )}
        {chatView ? (
          <ChatTitleButton projectId={project.id} activeId={conversationId} open={narrow ? listOpen : showRail} onClick={narrow ? () => setListOpen((v) => !v) : toggleRail} />
        ) : (
          <span className="min-w-0 truncate text-body-2 font-semibold" title={title}>{title}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1 text-hint">
          {status.data?.provider === "scripted" && (
            <span className="rounded border border-border px-1.5 text-caption" title="Dev: replies come from a fixture, not a model" data-testid="agent-scripted-badge">
              Scripted model
            </span>
          )}
          {ready && specialist && (
            <Button variant="ghost-secondary" size="sm" className="h-6 px-1.5 text-caption text-hint" onClick={() => setProfile("assistant")} disabled={!!running} title="Leave the specialist and go back to the assistant" data-testid="agent-specialist-back">
              {SPECIALIST_LABEL[specialist]} · Back to assistant
            </Button>
          )}
          {ready && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost-secondary" size="icon-sm" className="text-hint" onClick={startChat} disabled={thread.length === 0} aria-label="New chat" data-testid="agent-new-chat"><NewChatIcon /></Button>
              </TooltipTrigger>
              <TooltipContent>New chat</TooltipContent>
            </Tooltip>
          )}
          {ready && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost-secondary" size="icon-sm" className="text-hint" aria-label="Assistant options"><MoreIcon /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                {status.data?.model && <DropdownMenuLabel className="truncate font-normal text-hint">Model: {status.data.model}</DropdownMenuLabel>}
                {status.data?.model && <DropdownMenuSeparator />}
                {dropsOn && (
                  <DropdownMenuItem onSelect={() => setView(view === "files" ? "chat" : "files")} data-testid="agent-shared-files">
                    {view === "files" ? "Back to the chat" : "Shared files"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={!conversationId} onSelect={() => conversationId && removeWithUndo(project.id, conversationId)} data-testid="agent-delete-chat">Delete this chat</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="ghost-secondary" size="icon-sm" className="text-hint" onClick={onClose} aria-label="Close assistant"><CloseIcon /></Button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
      {showRail && <ChatRail projectId={project.id} activeId={conversationId} onNew={startChat} onPick={pickChat} className="w-52 shrink-0 border-r border-border" />}
      {showOverlay && (
        <div className="absolute inset-0 z-20 flex bg-float/60" onClick={(e) => e.target === e.currentTarget && setListOpen(false)}>
          <ChatRail projectId={project.id} activeId={conversationId} onNew={startChat} onPick={pickChat} className="w-full max-w-80 border-r border-border bg-float shadow-float-lg" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
      {status.isLoading ? (
        <div className="flex flex-1 flex-col" role="status" aria-label="Loading the assistant" data-testid="assistant-loading"><PanelBodySkeleton /></div>
      ) : !status.data?.configured ? (
        <>
          {!status.data && agentUnavailable(status.error) ? (
            <Unavailable retrying={status.isFetching} onRetry={() => void status.refetch()} studio={!!props.studio} />
          ) : (
            <NotConfigured status={status.data} studio={!!props.studio} />
          )}
          {/* Drop plans are the kernel's: they show (and apply) without the assistant. */}
          <DropPlanCards projectId={project.id} />
        </>
      ) : aiOff ? (
        <>
          <AiOff />
          <DropPlanCards projectId={project.id} />
        </>
      ) : view === "files" ? (
        <SharedFiles projectId={project.id} conversationId={conversationId} canEdit={canEdit} />
      ) : (
        <>
          <FollowedElsewhere />
          <Conversation {...props} thread={thread} status={status.data} running={running} busy={false} onScrolled={setScrolled} dropsOn={dropsOn} dropsPending={drops.pending} canEdit={canEdit} chatId={conversationId} />
        </>
      )}
      </div>
      </div>
    </aside>
  );
}

function Conversation({
  project,
  provider,
  runTool,
  studio,
  onUndo,
  placeholder,
  empty,
  bareSnapshot,
  thread,
  status,
  running,
  busy,
  onScrolled,
  taskId,
  dropsOn,
  dropsPending,
  canEdit,
  chatId,
}: AssistantPanelProps & { thread: ChatMessage[]; status: AgentStatus; running: boolean; busy: boolean; onScrolled: (scrolled: boolean) => void; dropsOn: boolean; dropsPending?: boolean; canEdit: boolean; chatId?: string }) {
  const send = useAgent((s) => s.send);
  const profile = useAgent((s) => s.profile);
  const dismissed = useAgentContextStore((s) => s.dismissed === provider.key);
  const ackAiNotice = useAckAiNotice();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const tools = useRef(runTool);
  tools.current = runTool;

  // The service asks for client tools by name; the host runs them (cards, the Studio's environment).
  useEffect(() => {
    useAgent.getState().setHost({ projectId: project.id, runTool: (name, input) => tools.current(name, input) });
    useAgent.getState().reattach(project.id);
    return () => useAgent.getState().setHost(null);
  }, [project.id]);

  // todo13: files dropped, pasted or attached before send join one pending drop; the message carries it.
  const [pending, setPending] = useState<{ dropId: string; messageId: string } | undefined>();
  const [dragging, setDragging] = useState(false);
  const canAttach = dropsOn || (!!runtimeConfig().kernel && !dropsPending);
  const dropFiles = useDropFiles();
  const [uploads, setUploads] = useState<string[]>([]);
  const [held, setHeld] = useState<{ text: string; keys: string[] } | null>(null);
  const heldReady = useUploads((s) => !!held && chatUploadsGate(held.keys.map((k) => s.sessions.find((x) => x.key === k))).ready);
  const addFiles = async (files: Picked | File[]) => {
    if (!canAttach || !canEdit) return;
    if (!dropsOn) {
      const picked = Array.isArray(files) ? fromFileList(files) : files;
      void dropFiles({ projectId: project.id, picked, origin: "chat", surface: "chat", taskId, onUploadKey: (key) => setUploads((u) => [...u, key]) });
      return;
    }
    // todo20 D2: the drop names the chat (= agent session) it's shared in; made on the server first.
    const conv = await useAgent.getState().ensureConversation(project.id, { restricted: project.restricted });
    const messageId = pending?.messageId ?? crypto.randomUUID();
    const dropId = startDrop({ projectId: project.id, origin: "chat", files, conversationId: conv.id, conversationTitle: conv.title, messageId, taskId, dropId: pending?.dropId });
    setPending({ dropId, messageId });
  };
  const attach: Attach = { on: canAttach, drops: dropsOn, pending: dropsPending, allowed: canEdit, onFiles: (f) => void addFiles(f) };

  const ask = (text: string, drop?: { dropId: string; messageId: string }) => {
    const t = text.trim();
    if (!drop && uploads.length) {
      setHeld({ text: t, keys: uploads });
      setUploads([]);
      return;
    }
    const withDrop = drop ?? pending;
    if ((!t && !withDrop) || busy) return;
    pinned.current = true;
    // `/studio <words>` boots from the preset table in the browser; no model turn (todo11 D5).
    if (!withDrop && STUDIO_COMMAND.test(t)) return runStudioCommand(project.id, t);
    const shared = !dismissed;
    if (!drop) setPending(undefined);
    ackAiNotice();
    void send(project.id, t, {
      ...sessionTools(profile),
      restricted: project.restricted,
      snapshot: shared ? provider.snapshot?.() : bareSnapshot?.(),
      context: shared ? provider.turnContext() : `Project: ${project.title} (${project.id})\nThe user removed the section context: nothing about their current selection is shared.`,
      ...(withDrop ? { drop: { dropId: withDrop.dropId }, messageId: withDrop.messageId, beforeSend: () => whenRegistered(withDrop.dropId) } : {}),
    });
  };
  // A message typed (or files dropped) on Home before this project existed (todo13 D1) is sent once, here.
  // todo16 round 2: a drop from the assistant's upload card comes the same way; while a run is
  // going it waits in the composer and goes with the next message.
  // todo18 D: it says so, and goes by itself when the current reply finishes.
  const [deferred, setDeferred] = useState<{ text: string; drop: { dropId: string; messageId: string } } | null>(null);
  const waitingForFiles = usePendingAsk(project.id, (text, drop, opts) => {
    // todo29 D1: attaching never sends: an attach-only drop waits in the composer for Send.
    if (drop && opts?.attachOnly) setPending(drop);
    else if (drop && (busy || running)) {
      setPending(drop);
      setDeferred({ text, drop });
    } else ask(text, drop);
  }, !!status?.configured);
  useEffect(() => {
    if (!deferred || busy || running) return;
    setDeferred(null);
    ask(deferred.text, deferred.drop);
    setPending(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, busy, running]);
  useEffect(() => {
    if (!held || !heldReady) return;
    const { note } = chatUploadsGate(held.keys.map((k) => useUploads.getState().sessions.find((x) => x.key === k)));
    setHeld(null);
    ask(withUploadNote(held.text, note));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, heldReady]);
  const retry = () => {
    const lastUser = [...thread].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const key = useAgent.getState().conversations[project.id]?.activeSessionId ?? project.id;
    useAgent.setState((s) => ({ threads: { ...s.threads, [key]: thread.slice(0, thread.lastIndexOf(lastUser)) } }));
    const drop = lastUser.parts.find((p) => p.type === "drop");
    ask(lastUser.parts.map((p) => (p.type === "text" ? p.text : "")).join(""), drop ? { dropId: drop.id, messageId: crypto.randomUUID() } : undefined);
  };

  // todo21 D5: a new chat with the thread up to message i; it opens.
  const canBranch = !!chatId && !chatId.startsWith("conv-");
  const branch = (i: number) => {
    if (!chatId) return;
    void useAgent
      .getState()
      .branchChat(project.id, chatId, i)
      .then((id) => !id && toast("This chat isn't saved yet, so it can't branch."))
      .catch(() => toast("Couldn't branch this chat. Try again."));
  };

  // Follow the stream unless the expert scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [thread]);

  const e = empty(profile);
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(ev) => {
        if (!attach.on || !hasFiles(ev.dataTransfer)) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = attach.allowed ? "copy" : "none";
        setDragging(true);
      }}
      onDragLeave={(ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(ev) => {
        if (!attach.on || !hasFiles(ev.dataTransfer)) return;
        ev.preventDefault();
        ev.stopPropagation();
        setDragging(false);
        if (attach.allowed) void fromDataTransfer(ev.dataTransfer).then((picked) => {
          if (picked.files.length) void addFiles(picked);
        });
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-brand bg-float/90 text-center" data-testid="agent-drop-overlay">
          <p className="max-w-60 text-body-2">{!attach.allowed ? "Ask a contributor to add files" : attach.drops ? "Drop files to share them in this chat" : "Drop files to add them to Sources and ask about them"}</p>
        </div>
      )}
      <div
        ref={scroller}
        onScroll={(ev) => {
          const el = ev.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          onScrolled(el.scrollTop > 0);
        }}
        className="thin-scrollbar min-h-0 flex-1 overflow-y-auto"
        data-testid="agent-log"
      >
        {chatId && <BranchedFrom projectId={project.id} chatId={chatId} />}
        {thread.length === 0 ? (
          <EmptyState title={e.title} body={e.body} prompts={e.prompts} footer={e.footer} onAsk={(t) => ask(t)} drops={attach.on && attach.allowed} />
        ) : (
          <div className="flex min-h-full flex-col justify-end gap-6 px-4 pt-2 pb-2">
            {thread.map((m, i) =>
              m.role === "user" ? (
                <UserMessage key={m.id} message={m} projectId={project.id} canEdit={canEdit} onBranch={canBranch && !(running && i >= thread.length - 2) ? () => branch(i) : undefined} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  message={m}
                  streaming={running && i === thread.length - 1}
                  latest={i === thread.length - 1}
                  projectId={project.id}
                  studio={studio}
                  onRetry={i === thread.length - 1 && !running ? retry : undefined}
                  onUndo={onUndo && ((partId) => onUndo(m.id, partId))}
                  onBranch={canBranch && !(running && i === thread.length - 1) ? () => branch(i) : undefined}
                />
              ),
            )}
          </div>
        )}
        <DropPlanCards projectId={project.id} />
      </div>
      <Composer
        project={project}
        provider={provider}
        placeholder={placeholder(profile)}
        running={running}
        busy={busy}
        onSend={(t) => ask(t)}
        studio={!!studio}
        fresh={thread.length === 0}
        attach={attach}
        pending={pending?.dropId}
        deferred={!!deferred}
        waitingForFiles={waitingForFiles || !!held}
        uploads={uploads}
        onRemoveUpload={(key) => {
          const s = useUploads.getState().sessions.find((x) => x.key === key);
          if (s && !settledPhase(s.phase)) void useUploads.getState().cancel(key);
          setUploads((u) => u.filter((k) => k !== key));
        }}
        onCancelDrop={() => {
          if (pending) void cancelDrop(pending.dropId);
          setPending(undefined);
          setDeferred(null);
        }}
      />
    </div>
  );
}

function EmptyState({ title, body, prompts, footer, onAsk, drops }: { title: string; body: ReactNode; prompts: Prompt[]; footer?: ReactNode; onAsk: (t: string) => void; drops?: boolean }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 px-4 py-6 text-center" data-testid="agent-empty">
      <div className="flex flex-col items-center">
        <span className="echo-star mb-3 flex size-12 items-center justify-center text-ai-text" aria-hidden>
          <AiIcon className="size-8" />
        </span>
        <h3 className="text-body-3 font-semibold">{title}</h3>
        <p className="mt-1.5 max-w-80 text-muted-foreground">{body}</p>
      </div>
      <ul className="flex w-full max-w-82 flex-col gap-3">
        {prompts.map(({ icon: I, text }) => (
          <li key={text}>
            <button
              onClick={() => onAsk(text)}
              className="press group flex min-h-11 w-full items-center gap-3 rounded-xl bg-background px-4 py-2.5 text-left text-complementary shadow-float-lg hover:bg-float-hover hover:text-foreground"
            >
              <I className="size-4 shrink-0 text-hint group-hover:text-complementary" />
              <span>{text}</span>
            </button>
          </li>
        ))}
      </ul>
      {footer}
    </div>
  );
}

function Composer({
  project,
  provider,
  placeholder,
  running,
  busy,
  onSend,
  studio,
  fresh,
  attach,
  pending,
  deferred,
  waitingForFiles,
  uploads,
  onRemoveUpload,
  onCancelDrop,
}: {
  project: AssistantProject;
  provider: AgentContextProvider;
  placeholder: string;
  running: boolean;
  busy: boolean;
  onSend: (t: string) => void;
  studio: boolean;
  fresh: boolean;
  attach: Attach;
  pending?: string;
  deferred?: boolean;
  /** Home's message waits for its upload to finish (todo24 D2). */
  waitingForFiles?: boolean;
  /** Tray uploads attached to the next message (chat drops off). */
  uploads: string[];
  onRemoveUpload: (key: string) => void;
  onCancelDrop: () => void;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const canSend = !!text.trim() || !!pending || uploads.length > 0;
  const stop = useAgent((s) => s.stop);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // Something asked the composer to take focus ("Or tell <displayName>…" on Overview).
  const focusTick = useShell((s) => s.assistantFocus);
  useEffect(() => {
    if (focusTick) area.current?.focus();
  }, [focusTick]);

  // While a run is active, a message steers it (the service queues it after the current step).
  const submit = () => {
    if (!canSend || busy) return;
    onSend(text);
    setText("");
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 px-4 pt-3 pb-3">
      <div
        className={cn(
          "flex min-h-30 cursor-text flex-col rounded-xl border border-border bg-background p-3 transition-colors focus-within:border-brand-heavy",
          fresh && !text && "echo-ring",
        )}
        onClick={(e) => e.target === e.currentTarget && area.current?.focus()}
      >
        {waitingForFiles && (
          <p className="mb-2 text-hint text-muted-foreground" data-testid="agent-waiting-files">
            Your message goes once your files finish uploading.
          </p>
        )}
        {pending && (
          <div className="mb-2">
            <AttachmentTiles dropId={pending} projectId={project.id} variant="composer" onCancel={onCancelDrop} />
            {deferred && (
              <p className="mt-1 text-hint text-muted-foreground" data-testid="agent-drop-deferred">
                Will send when the current reply finishes.
              </p>
            )}
          </div>
        )}
        {uploads.length > 0 && (
          <ul className="mb-2 flex flex-col gap-1" data-testid="agent-uploads">
            {uploads.map((key) => (
              <UploadRow key={key} uploadKey={key} onRemove={() => onRemoveUpload(key)} />
            ))}
          </ul>
        )}
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape" && running) stop(project.id);
          }}
          onPaste={(e) => {
            // A pasted screenshot (or copied files) becomes a drop, like an attached file.
            const files = e.clipboardData?.files;
            if (!attach.on || !files?.length) return;
            e.preventDefault();
            if (attach.allowed) attach.onFiles(pastedFiles(files));
          }}
          rows={2}
          placeholder={running ? "Add to the current request…" : placeholder}
          aria-label={`Message ${NAMING.displayName} AI`}
          className="block max-h-55 min-h-11 w-full flex-1 resize-none bg-transparent text-chat outline-none placeholder:text-hint focus-visible:outline-none"
        />
        <div className="mt-2 flex items-end gap-2">
          {attach.pending && <Skeleton className="size-9 rounded-md" data-testid="agent-attach-pending" />}
          {attach.on && (
            <>
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={attach.allowed ? -1 : 0} className="inline-flex">
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost-secondary"
                          size="icon-lg"
                          className="text-hint disabled:opacity-50"
                          disabled={!attach.allowed}
                          aria-label={attach.allowed ? "Attach files" : "Ask a contributor to add files"}
                          title={attach.allowed ? undefined : "Ask a contributor to add files"}
                          data-testid="agent-attach"
                        >
                          <AttachIcon />
                        </Button>
                      </DropdownMenuTrigger>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{attach.allowed ? "Attach files or a folder" : "Ask a contributor to add files"}</TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => picker.current?.click()} data-testid="agent-attach-files">
                    <AddDataIcon /> Files…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => folderPicker.current?.click()} data-testid="agent-attach-folder">
                    <FolderIcon /> Folder…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <input
                ref={folderPicker}
                type="file"
                multiple
                hidden
                data-testid="agent-attach-folder-input"
                {...{ webkitdirectory: "", directory: "" }}
                onChange={(e) => {
                  if (e.target.files?.length) attach.onFiles(fromFileList(e.target.files));
                  e.target.value = "";
                }}
              />
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                data-testid="agent-attach-input"
                onChange={(e) => {
                  if (e.target.files?.length) attach.onFiles(fromFileList(e.target.files));
                  e.target.value = "";
                }}
              />
            </>
          )}
          <ContextIndicator provider={provider} />
          {running && !canSend ? (
            <Button variant="secondary" size="icon-lg" className="ml-auto" onClick={() => stop(project.id)} aria-label="Stop generating"><StopIcon /></Button>
          ) : (
            <Button variant={canSend ? "default" : "secondary"} size="icon-lg" className="ml-auto disabled:text-hint" onClick={submit} disabled={!canSend || busy} aria-label="Send"><SubmitIcon /></Button>
          )}
        </div>
      </div>
      {!!project.heldFiles && (
        <p className="px-1 text-center text-caption text-hint">
          <span data-testid="agent-held-note">{project.heldFiles === 1 ? "1 file held for privacy review isn't" : `${project.heldFiles} files held for privacy review aren't`} shared with the assistant.</span>
        </p>
      )}
    </div>
  );
}

function UploadRow({ uploadKey, onRemove }: { uploadKey: string; onRemove: () => void }) {
  const s = useUploads((st) => st.sessions.find((x) => x.key === uploadKey));
  if (!s) return null;
  const settled = settledPhase(s.phase);
  return (
    <li className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-hint" data-testid="agent-upload">
      {settled ? <AddDataIcon className="size-4 shrink-0" /> : <Spinner className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate" title={s.title}>{trayLine(s)}</span>
      <Button variant="ghost-secondary" size="icon-sm" className="text-hint" onClick={onRemove} aria-label={settled ? "Remove from this message" : "Cancel upload"} data-testid="agent-upload-remove"><CloseIcon /></Button>
    </li>
  );
}

/**
 * What the assistant can see ("Sources › MRI/patient_002"), above the composer. Removing it
 * stops sending the selection until the context changes; the "+" brings it back.
 */
export function ContextIndicator({ provider }: { provider: AgentContextProvider }) {
  const dismissed = useAgentContextStore((s) => s.dismissed === provider.key);
  const dismiss = useAgentContextStore((s) => s.dismiss);
  const restore = useAgentContextStore((s) => s.restore);
  const total = useStudio((s) => (provider.snapshot ? s.annotations.length : 0));
  const cut = snapshotTruncation(total);
  if (dismissed)
    return (
      <button
        type="button"
        onClick={restore}
        className="inline-flex h-8.5 min-w-0 items-center gap-2 rounded-lg border border-dashed border-border px-2 text-hint hover:text-foreground"
        data-testid="agent-context"
        data-dismissed="true"
        aria-label={`Share ${provider.label} again`}
      >
        <span className="truncate">+ {provider.label}</span>
      </button>
    );
  return (
    <span className="inline-flex h-8.5 min-w-0 items-center gap-2 rounded-lg pl-2 text-hint hover:bg-generic" data-testid="agent-context">
      <ShowIcon className="size-4 shrink-0" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="truncate" tabIndex={0}>{provider.label}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          {provider.shares}
          {cut && <span className="mt-1 block">{cut}.</span>}
        </TooltipContent>
      </Tooltip>
      {cut && (
        <span className="shrink-0 text-caption text-warning" data-testid="agent-context-truncated" title={cut}>
          first {MAX_ANNOTATIONS.toLocaleString("en-US")}
        </span>
      )}
      <button type="button" onClick={dismiss} className="flex h-8.5 w-6 shrink-0 items-center justify-center rounded-r-lg text-hint hover:text-foreground" aria-label="Don't share this context">
        <CloseIcon className="size-3" />
      </button>
    </span>
  );
}

const RAIL_PREF = `${RES}-agent-chat-rail`;
function readRailPref(): boolean {
  try {
    return localStorage.getItem(RAIL_PREF) !== "closed";
  } catch {
    return true;
  }
}
function writeRailPref(open: boolean) {
  try {
    localStorage.setItem(RAIL_PREF, open ? "open" : "closed");
  } catch {
    // Private window: the rail just opens by default next time.
  }
}

/** Whether the element is narrower than `px` (todo21 D3: the rail collapses under 520 px). */
function useNarrow(ref: RefObject<HTMLElement | null>, px: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setNarrow(el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().width < px);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, px]);
  return narrow;
}

/** Hide a chat now and delete it after a few seconds, with Undo in the toast. */
function removeWithUndo(projectId: string, chatId: string) {
  const undo = useAgent.getState().removeChat(projectId, chatId, 6000);
  toast("Chat deleted", { duration: 6000, action: { label: <span data-testid="agent-chat-undo">Undo</span>, onClick: undo } });
}

const ts = (v: number | string | null | undefined) => (v == null ? 0 : typeof v === "number" ? v : Date.parse(v) || 0);

/** Chats newest first, each branch right under its source (indented), so a thread's branches read as a tree. */
export function railOrder(chats: ChatSummary[]): { chat: ChatSummary; depth: number }[] {
  const ids = new Set(chats.map((c) => c.id));
  const children = new Map<string, ChatSummary[]>();
  const roots: ChatSummary[] = [];
  for (const c of chats) {
    const src = c.branchedFrom?.sessionId;
    if (src && ids.has(src) && src !== c.id) children.set(src, [...(children.get(src) ?? []), c]);
    else roots.push(c);
  }
  const out: { chat: ChatSummary; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (c: ChatSummary, depth: number) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    out.push({ chat: c, depth });
    for (const k of children.get(c.id) ?? []) walk(k, Math.min(depth + 1, 3));
  };
  roots.forEach((c) => walk(c, 0));
  // A cycle (never expected) still lists everything.
  chats.forEach((c) => walk(c, 0));
  return out;
}

/** The open chat's title in the header: toggles the rail (or, when narrow, the list over the thread). */
function ChatTitleButton({ projectId, activeId, open, onClick }: { projectId: string; activeId?: string; open: boolean; onClick: () => void }) {
  const current = useAgent((s) => chatTitle(s, { id: activeId ?? "", title: (s.chats[projectId] ?? []).find((c) => c.id === activeId)?.title ?? null }));
  return (
    <button type="button" onClick={onClick} className="flex min-w-0 items-center gap-1 rounded-md px-1 text-left text-body-2 font-semibold hover:bg-generic" title={current} aria-expanded={open} data-testid="agent-chat-switcher">
      <span className="truncate">{current}</span>
      <ChevronDownIcon className={cn("size-3.5 shrink-0 text-hint transition-transform", open && "rotate-180")} />
    </button>
  );
}

/**
 * todo21 D3: the project's chats, newest first, with a spinner while one runs and a dot when a
 * reply finished while you were elsewhere. Double-click (or the row menu) renames; the menu
 * also branches from the last message and deletes (with Undo).
 */
function ChatRail({ projectId, activeId, onNew, onPick, className }: { projectId: string; activeId?: string; onNew: () => void; onPick: (id: string) => void; className?: string }) {
  const chats = useAgent((s) => s.chats[projectId] ?? NO_CHATS);
  const rows = railOrder(chats);
  return (
    <nav className={cn("flex min-h-0 flex-col", className)} aria-label="Chats" data-testid="agent-chat-list">
      <div className="px-2 pt-1 pb-1">
        <Button variant="ghost-secondary" size="sm" className="w-full justify-start gap-2 text-complementary" onClick={onNew} data-testid="agent-chat-new">
          <NewChatIcon /> New chat
        </Button>
      </div>
      <ul className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {rows.map(({ chat, depth }) => (
          <ChatRow key={chat.id} projectId={projectId} chat={chat} depth={depth} active={chat.id === activeId} onPick={() => onPick(chat.id)} />
        ))}
      </ul>
    </nav>
  );
}

function ChatRow({ projectId, chat, depth, active, onPick }: { projectId: string; chat: ChatSummary; depth: number; active: boolean; onPick: () => void }) {
  const running = useAgent((s) => !!s.streaming[chat.id] || !!s.runs[chat.id] || (!!chat.running && !s.unread[chat.id]));
  const unread = useAgent((s) => !active && (!!s.unread[chat.id] || (!!chat.lastRunAt && !!s.lastOpened[chat.id] && ts(chat.lastRunAt) > ts(s.lastOpened[chat.id]))));
  const title = chatTitle({ threads: {} }, chat);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const local = chat.id.startsWith("conv-");
  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    if (!t || t === title) return;
    void useAgent.getState().renameChat(projectId, chat.id, t).catch(() => toast("Couldn't rename the chat."));
  };
  const branchLast = async () => {
    const st = useAgent.getState();
    if (!st.threads[chat.id]?.length) await st.loadThread(chat.id);
    const n = useAgent.getState().threads[chat.id]?.length ?? 0;
    if (!n) return void toast("This chat has no messages to branch from.");
    await st.branchChat(projectId, chat.id, n - 1).catch(() => toast("Couldn't branch this chat. Try again."));
  };
  return (
    <li
      className={cn("group/row relative flex h-8 items-center rounded-md text-complementary hover:bg-generic", active && "bg-generic text-foreground")}
      style={depth ? { paddingLeft: depth * 12 } : undefined}
      data-testid="agent-chat-item"
      data-active={active || undefined}
      data-running={running || undefined}
      data-unread={unread || undefined}
      data-branch={depth > 0 || undefined}
    >
      {editing ? (
        <Input
          autoFocus
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-7 px-2 text-body-2"
          aria-label="Chat name"
          data-testid="agent-chat-rename-input"
        />
      ) : (
        <>
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-7 pl-2 text-left"
            onClick={onPick}
            onDoubleClick={() => {
              if (local) return;
              setDraft(title);
              setEditing(true);
            }}
            title={title}
            aria-current={active || undefined}
          >
            {depth > 0 && <BranchIcon className="size-3 shrink-0 text-hint" />}
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {running ? (
              <Spinner size="s" data-testid="agent-chat-running" />
            ) : unread ? (
              <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-label="New reply" data-testid="agent-chat-unread" />
            ) : null}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost-secondary" size="icon-sm" className="absolute right-0.5 size-6 text-hint opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={`Options for ${title}`} data-testid="agent-chat-menu">
                <MoreIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem disabled={local} onSelect={() => (setDraft(title), setEditing(true))} data-testid="agent-chat-rename"><RenameIcon /> Rename</DropdownMenuItem>
              <DropdownMenuItem disabled={local} onSelect={() => void branchLast()} data-testid="agent-chat-branch"><BranchIcon /> Branch</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => removeWithUndo(projectId, chat.id)} className="text-danger" data-testid="agent-chat-delete"><DeleteIcon /> Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </li>
  );
}

/** todo21 D5: at the top of a branched thread, the chat it came from (click to open it). */
function BranchedFrom({ projectId, chatId }: { projectId: string; chatId: string }) {
  const from = useAgent((s) => (s.chats[projectId] ?? []).find((c) => c.id === chatId)?.branchedFrom ?? null);
  const source = useAgent((s) => (from ? (s.chats[projectId] ?? []).find((c) => c.id === from.sessionId) : undefined));
  if (!from) return null;
  return (
    <p className="flex items-center gap-1.5 px-4 pt-2 text-hint" data-testid="agent-branched-from">
      <BranchIcon className="size-3.5 shrink-0" />
      Branched from{" "}
      {source ? (
        <button type="button" className="min-w-0 truncate text-brand underline-offset-2 hover:underline" onClick={() => useAgent.getState().selectChat(projectId, source.id)}>
          {chatTitle({ threads: {} }, source)}
        </button>
      ) : (
        <span>a deleted chat</span>
      )}
    </p>
  );
}

/** D2: an org admin turned the assistant off (`aiAssist`); drops and their plans still work. */
function AiOff() {
  return (
    <div className="flex flex-col gap-3 px-4 pt-6" data-testid="agent-off">
      <span className="flex size-8 items-center justify-center rounded-lg bg-generic text-hint"><AiIcon className="size-4" /></span>
      <h3 className="text-body-2 font-semibold">The assistant is off for this organization</h3>
      <p className="text-muted-foreground">An admin can turn it on in Organization settings. Dropped files still go to the project's Sources.</p>
    </div>
  );
}

/** The agent didn't answer (502/503/504, timeout, network): say so, with Retry (todo15 D5). */
function Unavailable({ retrying, onRetry, studio }: { retrying: boolean; onRetry: () => void; studio: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-3 px-4 pt-6" data-testid="agent-unavailable">
      <span className="flex size-8 items-center justify-center rounded-lg bg-generic text-hint"><AiIcon className="size-4" /></span>
      <h3 className="text-body-2 font-semibold">The assistant is unavailable right now</h3>
      <p className="text-muted-foreground">
        It didn't answer. Try again in a moment.
        {import.meta.env.DEV && (
          <> In development, start it with <code className="rounded-xs bg-generic px-1 font-mono text-code">pnpm agent</code>.</>
        )}
      </p>
      <div>
        <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry} data-testid="agent-retry">{retrying ? "Retrying" : "Retry"}</Button>
      </div>
      <p className="text-muted-foreground">{studio ? "Everything else in the Studio works without it." : "Everything else works without it."}</p>
    </div>
  );
}

function NotConfigured({ status, studio }: { status: AgentStatus | undefined; studio: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-3 px-4 pt-6">
      <span className="flex size-8 items-center justify-center rounded-lg bg-generic text-hint"><AiIcon className="size-4" /></span>
      <h3 className="text-body-2 font-semibold">{status ? "No model connected" : "Assistant not running"}</h3>
      {status ? (
        <p className="text-muted-foreground">
          The agent service has no key for {status.provider}. Add <code className="rounded-xs bg-generic px-1 font-mono text-code">{status.provider.toUpperCase()}_API_KEY</code> to <code className="rounded-xs bg-generic px-1 font-mono text-code">secrets/models.env</code> and restart it.
        </p>
      ) : (
        <p className="text-muted-foreground">
          Start the agent service with <code className="rounded-xs bg-generic px-1 font-mono text-code">pnpm agent</code>, then reopen this panel.
        </p>
      )}
      <p className="text-muted-foreground">{studio ? "Everything else in the Studio works without it." : "Everything else works without it."}</p>
    </div>
  );
}

/** todo18 D: another tab streams this run; this one can take it back. */
function FollowedElsewhere() {
  const elsewhere = useAgent((s) => !!s.followedElsewhere && Object.values(s.runs).some((r) => r.runId === s.followedElsewhere));
  const takeOver = useAgent((s) => s.takeOver);
  if (!elsewhere) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-hint" data-testid="agent-followed-elsewhere">
      Following in another tab
      <Button variant="ghost" size="sm" onClick={takeOver} data-testid="agent-take-over">
        Take over
      </Button>
    </div>
  );
}
