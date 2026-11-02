import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { DropPlanCards } from "@/studio/core/drops";
import { useQuery } from "@tanstack/react-query";
import { AiIcon, AttachIcon, ChevronLeftIcon, CloseIcon, MoreIcon, NewChatIcon, ShowIcon, StopIcon, SubmitIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@studio/ui/ui/dropdown-menu";
import { PanelBodySkeleton } from "@/studio/components/studio/ModuleSlot";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { cn } from "@studio/ui/utils";
import type { AgentStatus, ProfileName } from "@studio/agent-protocol";
import { NAMING } from "@studio/contracts/naming";
import { agentUnavailable, fetchAgentStatus } from "@/studio/lib/agent/client";
import { useAgentContextStore, type AgentContextProvider } from "@/studio/lib/agent/providers";
import { PROFILES, sessionTools } from "@/studio/lib/agent/session";
import { useAgent, type ChatMessage, type ClientToolOutcome } from "@/studio/stores/agent";
import { useShell } from "@/studio/stores/shell";
import { AssistantMessage, UserMessage } from "./thread";
import { useAckAiNotice, useAiAssistOff } from "./ai-notice";
import { runStudioCommand, STUDIO_COMMAND } from "@/studio/lib/studio-boot";
import type { StudioCardContext } from "./cards";
import { usePendingAsk } from "@/studio/app/entry/pending-ask";
import { cancelDrop, DropCard, pastedFiles, SharedFiles, startDrop, useChatDropsEnabled, whenRegistered } from "@/studio/core/drops";
import { useProjectSummary } from "@/studio/lib/projects-api";
import { fromDataTransfer, fromFileList, hasFiles, type Picked } from "@/studio/lib/uploads/walk";

/**
 * The assistant (docs/ux.md §9), shared by its two hosts (todo6 Phase 6): the Studio's right
 * slot (`core/panels/ai.tsx`) and the project shell's `PersistentAgentDrawer`. One thread and
 * one service session per project (`stores/agent.ts`), so the conversation carries across
 * sections; what it can see comes from the section's `AgentContextProvider` and is shown, and
 * removable, in the `ContextIndicator` chip. Every flow works with it closed.
 */

const EMPTY: ChatMessage[] = [];

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
  /** Chat drops are on (`API_FEATURE_CHAT_DROPS`). */
  on: boolean;
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
  const thread = useAgent((s) => s.threads[project.id] ?? EMPTY);
  const running = useAgent((s) => s.running);
  const reset = useAgent((s) => s.reset);
  const profile = useAgent((s) => s.profile);
  const setProfile = useAgent((s) => s.setProfile);
  const ready = !!status.data?.configured && !aiOff;
  const profiles = PROFILES.filter((p) => status.data?.profiles.includes(p.id) ?? p.id !== "coder");
  const [scrolled, setScrolled] = useState(false);
  const [view, setView] = useState<"chat" | "files">("chat");
  const drops = useChatDropsEnabled(project.id);
  const dropsOn = drops.data === true;
  const canEdit = useProjectSummary(project.id).data?.role !== "viewer";
  const conversationId = useAgent((s) => s.conversations[project.id]?.id);
  const first = thread.find((m) => m.role === "user")?.parts.find((p) => p.type === "text");
  const title = view === "files" ? "Shared files" : ready ? (first?.type === "text" ? first.text : "New chat") : `${NAMING.displayName} AI`;

  return (
    <aside className="flex h-full min-w-0 flex-col bg-float" aria-label={`${NAMING.displayName} AI`}>
      <header className={cn("flex shrink-0 items-center gap-2 border-b pt-3 pr-3 pb-2 pl-4", scrolled && ready && thread.length > 0 ? "border-border" : "border-transparent")}>
        {view === "files" ? (
          <Button variant="ghost-secondary" size="icon-sm" className="-ml-1 text-hint" onClick={() => setView("chat")} aria-label="Back to the chat" data-testid="agent-back-to-chat"><ChevronLeftIcon /></Button>
        ) : (
          <AiIcon className="size-4 shrink-0 text-ai-text" />
        )}
        <h2 className="sr-only">{NAMING.displayName} AI</h2>
        <span className="min-w-0 truncate text-body-2 font-semibold" title={title}>{title}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1 text-hint">
          {ready && thread.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost-secondary" size="icon-sm" className="text-hint" onClick={() => reset(project.id)} aria-label="New chat"><NewChatIcon /></Button>
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
                <DropdownMenuLabel>Mode</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={profile} onValueChange={(v) => setProfile(v as ProfileName)}>
                  {profiles.map((p) => (
                    <DropdownMenuRadioItem key={p.id} value={p.id} disabled={!!running}>
                      <div className="flex flex-col">
                        <span>{p.label}</span>
                        <span className="text-caption text-hint">{p.hint}</span>
                      </div>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                {dropsOn && (
                  <DropdownMenuItem onSelect={() => setView(view === "files" ? "chat" : "files")} data-testid="agent-shared-files">
                    {view === "files" ? "Back to the chat" : "Shared files"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={!thread.length} onSelect={() => reset(project.id)}>Clear conversation</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="ghost-secondary" size="icon-sm" className="text-hint" onClick={onClose} aria-label="Close assistant"><CloseIcon /></Button>
        </div>
      </header>

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
        <Conversation {...props} thread={thread} status={status.data} running={running === project.id} busy={!!running && running !== project.id} onScrolled={setScrolled} dropsOn={dropsOn} dropsPending={drops.pending} canEdit={canEdit} />
      )}
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
  running,
  busy,
  onScrolled,
  taskId,
  dropsOn,
  dropsPending,
  canEdit,
}: AssistantPanelProps & { thread: ChatMessage[]; status: AgentStatus; running: boolean; busy: boolean; onScrolled: (scrolled: boolean) => void; dropsOn: boolean; dropsPending?: boolean; canEdit: boolean }) {
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
  const addFiles = (files: Picked | File[]) => {
    if (!dropsOn || !canEdit) return;
    const conv = useAgent.getState().conversation(project.id);
    const messageId = pending?.messageId ?? crypto.randomUUID();
    const dropId = startDrop({ projectId: project.id, origin: "chat", files, conversationId: conv.id, conversationTitle: conv.title, messageId, taskId, dropId: pending?.dropId });
    setPending({ dropId, messageId });
  };
  const attach: Attach = { on: dropsOn, pending: dropsPending, allowed: canEdit, onFiles: addFiles };

  const ask = (text: string, drop?: { dropId: string; messageId: string }) => {
    const t = text.trim();
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
  usePendingAsk(project.id, (text, drop) => {
    if (drop && (busy || running)) {
      setPending(drop);
      setDeferred({ text, drop });
    } else ask(text, drop);
  });
  useEffect(() => {
    if (!deferred || busy || running) return;
    setDeferred(null);
    ask(deferred.text, deferred.drop);
    setPending(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferred, busy, running]);
  const retry = () => {
    const lastUser = [...thread].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    useAgent.setState((s) => ({ threads: { ...s.threads, [project.id]: thread.slice(0, thread.lastIndexOf(lastUser)) } }));
    const drop = lastUser.parts.find((p) => p.type === "drop");
    ask(lastUser.parts.map((p) => (p.type === "text" ? p.text : "")).join(""), drop ? { dropId: drop.id, messageId: crypto.randomUUID() } : undefined);
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
        if (attach.allowed) void fromDataTransfer(ev.dataTransfer).then((picked) => picked.files.length && addFiles(picked));
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-brand bg-float/90 text-center" data-testid="agent-drop-overlay">
          <p className="max-w-60 text-body-2">{attach.allowed ? "Drop files to share them in this chat" : "Ask a contributor to add files"}</p>
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
        {thread.length === 0 ? (
          <EmptyState title={e.title} body={e.body} prompts={e.prompts} footer={e.footer} onAsk={(t) => ask(t)} drops={attach.on && attach.allowed} />
        ) : (
          <div className="flex min-h-full flex-col justify-end gap-6 px-4 pt-2 pb-2">
            {thread.map((m, i) =>
              m.role === "user" ? (
                <UserMessage key={m.id} message={m} projectId={project.id} canEdit={canEdit} />
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
  onCancelDrop: () => void;
}) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const canSend = !!text.trim() || !!pending;
  const stop = useAgent((s) => s.stop);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // Something asked the composer to take focus ("Or tell Inkling…" on Overview).
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
        {pending && (
          <div className="mb-2">
            <DropCard dropId={pending} projectId={project.id} variant="composer" onCancel={onCancelDrop} />
            {deferred && (
              <p className="mt-1 text-hint text-muted-foreground" data-testid="agent-drop-deferred">
                Will send when the current reply finishes.
              </p>
            )}
          </div>
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
            if (e.key === "Escape" && running) stop();
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
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={attach.allowed ? -1 : 0} className="inline-flex">
                    <Button
                      variant="ghost-secondary"
                      size="icon-lg"
                      className="text-hint disabled:opacity-50"
                      onClick={() => picker.current?.click()}
                      disabled={!attach.allowed}
                      aria-label={attach.allowed ? "Attach files" : "Ask a contributor to add files"}
                      title={attach.allowed ? undefined : "Ask a contributor to add files"}
                      data-testid="agent-attach"
                    >
                      <AttachIcon />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{attach.allowed ? "Attach files" : "Ask a contributor to add files"}</TooltipContent>
              </Tooltip>
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
            <Button variant="secondary" size="icon-lg" className="ml-auto" onClick={stop} aria-label="Stop generating"><StopIcon /></Button>
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

/**
 * What the assistant can see ("Sources › MRI/patient_002"), above the composer. Removing it
 * stops sending the selection until the context changes; the "+" brings it back.
 */
export function ContextIndicator({ provider }: { provider: AgentContextProvider }) {
  const dismissed = useAgentContextStore((s) => s.dismissed === provider.key);
  const dismiss = useAgentContextStore((s) => s.dismiss);
  const restore = useAgentContextStore((s) => s.restore);
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
        <TooltipContent className="max-w-64">{provider.shares}</TooltipContent>
      </Tooltip>
      <button type="button" onClick={dismiss} className="flex h-8.5 w-6 shrink-0 items-center justify-center rounded-r-lg text-hint hover:text-foreground" aria-label="Don't share this context">
        <CloseIcon className="size-3" />
      </button>
    </span>
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
