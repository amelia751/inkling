import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { AiIcon, CloseIcon, MoreIcon, NewChatIcon, ShowIcon, StopIcon, SubmitIcon } from "@studio/ui/icons";
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
import { Loader } from "@studio/ui/ui/loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { cn } from "@studio/ui/utils";
import type { AgentStatus, ProfileName } from "@studio/agent-protocol";
import { NAMING } from "@studio/contracts/naming";
import { fetchAgentStatus } from "@/studio/lib/agent/client";
import { useAgentContextStore, type AgentContextProvider } from "@/studio/lib/agent/providers";
import { PROFILES, sessionTools } from "@/studio/lib/agent/session";
import { useAgent, type ChatMessage, type ClientToolOutcome } from "@/studio/stores/agent";
import { useShell } from "@/studio/stores/shell";
import { AssistantMessage, UserMessage } from "./thread";
import type { StudioCardContext } from "./cards";

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
  /** The Studio: its cards act on these items, and its consent lists the dataset snapshot. */
  studio?: StudioCardContext;
  /** Undo an environment change from the thread (the Studio). */
  onUndo?: (messageId: string, partId: string) => void;
  /** Composer placeholder for a profile. */
  placeholder: (profile: ProfileName) => string;
  empty: (profile: ProfileName) => { title: string; body: ReactNode; prompts: Prompt[] };
  /** Called with the snapshot to send when the chip is removed (the Studio: name only). */
  bareSnapshot?: () => ReturnType<NonNullable<AgentContextProvider["snapshot"]>>;
}

export function AssistantPanel(props: AssistantPanelProps) {
  const { project, onClose } = props;
  const status = useQuery({ queryKey: ["agent-status"], queryFn: fetchAgentStatus, staleTime: 60_000, retry: false });
  const consent = useAgent((s) => s.consent);
  const setConsent = useAgent((s) => s.setConsent);
  const thread = useAgent((s) => s.threads[project.id] ?? EMPTY);
  const running = useAgent((s) => s.running);
  const reset = useAgent((s) => s.reset);
  const profile = useAgent((s) => s.profile);
  const setProfile = useAgent((s) => s.setProfile);
  const ready = !!status.data?.configured && consent;
  const profiles = PROFILES.filter((p) => status.data?.profiles.includes(p.id) ?? p.id !== "coder");
  const [scrolled, setScrolled] = useState(false);
  const first = thread.find((m) => m.role === "user")?.parts.find((p) => p.type === "text");
  const title = ready ? (first?.type === "text" ? first.text : "New chat") : `${NAMING.displayName} AI`;

  return (
    <aside className="flex h-full min-w-0 flex-col bg-float" aria-label={`${NAMING.displayName} AI`}>
      <header className={cn("flex shrink-0 items-center gap-2 border-b pt-3 pr-3 pb-2 pl-4", scrolled && ready && thread.length > 0 ? "border-border" : "border-transparent")}>
        <AiIcon className="size-4 shrink-0 text-ai-text" />
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
          {consent && (
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
                <DropdownMenuItem disabled={!thread.length} onSelect={() => reset(project.id)}>Clear conversation</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setConsent(false)}>Stop sharing with {status.data?.provider ?? "the model"}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="ghost-secondary" size="icon-sm" className="text-hint" onClick={onClose} aria-label="Close assistant"><CloseIcon /></Button>
        </div>
      </header>

      {status.isLoading ? (
        <div className="flex flex-1 items-center justify-center"><Loader /></div>
      ) : !status.data?.configured ? (
        <NotConfigured status={status.data} studio={!!props.studio} />
      ) : !consent ? (
        <Consent provider={status.data.provider} model={status.data.model ?? ""} project={project} studio={!!props.studio} onAccept={() => setConsent(true)} />
      ) : (
        <Conversation {...props} thread={thread} status={status.data} running={running === project.id} busy={!!running && running !== project.id} onScrolled={setScrolled} />
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
}: AssistantPanelProps & { thread: ChatMessage[]; status: AgentStatus; running: boolean; busy: boolean; onScrolled: (scrolled: boolean) => void }) {
  const send = useAgent((s) => s.send);
  const profile = useAgent((s) => s.profile);
  const dismissed = useAgentContextStore((s) => s.dismissed === provider.key);
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

  const ask = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    pinned.current = true;
    const shared = !dismissed;
    void send(project.id, t, {
      ...sessionTools(profile),
      restricted: project.restricted,
      snapshot: shared ? provider.snapshot?.() : bareSnapshot?.(),
      context: shared ? provider.turnContext() : `Project: ${project.title} (${project.id})\nThe user removed the section context: nothing about their current selection is shared.`,
    });
  };
  const retry = () => {
    const lastUser = [...thread].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    useAgent.setState((s) => ({ threads: { ...s.threads, [project.id]: thread.slice(0, thread.lastIndexOf(lastUser)) } }));
    ask(lastUser.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
  };

  // Follow the stream unless the expert scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [thread]);

  const e = empty(profile);
  return (
    <>
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
          <EmptyState title={e.title} body={e.body} prompts={e.prompts} onAsk={ask} />
        ) : (
          <div className="flex min-h-full flex-col justify-end gap-6 px-4 pt-2 pb-2">
            {thread.map((m, i) =>
              m.role === "user" ? (
                <UserMessage key={m.id} message={m} />
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
      </div>
      <Composer project={project} provider={provider} placeholder={placeholder(profile)} running={running} busy={busy} onSend={ask} studio={!!studio} fresh={thread.length === 0} />
    </>
  );
}

function EmptyState({ title, body, prompts, onAsk }: { title: string; body: ReactNode; prompts: Prompt[]; onAsk: (t: string) => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 px-4 py-6 text-center">
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
    </div>
  );
}

function Composer({ project, provider, placeholder, running, busy, onSend, studio, fresh }: { project: AssistantProject; provider: AgentContextProvider; placeholder: string; running: boolean; busy: boolean; onSend: (t: string) => void; studio: boolean; fresh: boolean }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
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
    if (!text.trim() || busy) return;
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
          rows={2}
          placeholder={running ? "Add to the current request…" : placeholder}
          aria-label={`Message ${NAMING.displayName} AI`}
          className="block max-h-55 min-h-11 w-full flex-1 resize-none bg-transparent text-chat outline-none placeholder:text-hint focus-visible:outline-none"
        />
        <div className="mt-2 flex items-end gap-2">
          <ContextIndicator provider={provider} />
          {running && !text.trim() ? (
            <Button variant="secondary" size="icon-lg" className="ml-auto" onClick={stop} aria-label="Stop generating"><StopIcon /></Button>
          ) : (
            <Button variant={text.trim() ? "default" : "secondary"} size="icon-lg" className="ml-auto disabled:text-hint" onClick={submit} disabled={!text.trim() || busy} aria-label="Send"><SubmitIcon /></Button>
          )}
        </div>
      </div>
      <p className="px-1 text-center text-caption text-hint">
        {studio ? "Sees a text summary only, never images. Can be wrong. Changes need your approval or can be undone." : "Sees project metadata only, never file contents. Can be wrong. It proposes; you confirm."}
        {!!project.heldFiles && <span data-testid="agent-held-note"> {project.heldFiles === 1 ? "1 file held for privacy review isn't" : `${project.heldFiles} files held for privacy review aren't`} shared with it.</span>}
      </p>
    </div>
  );
}

/**
 * What the assistant can see ("Data › MRI/patient_002"), above the composer. Removing it
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

function Consent({ provider, model, project, studio, onAccept }: { provider: string; model: string; project: AssistantProject; studio: boolean; onAccept: () => void }) {
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pt-6 pb-4" data-testid="agent-consent">
      <span className="echo-star flex size-10 items-center justify-center text-ai-text" aria-hidden><AiIcon className="size-7" /></span>
      <div>
        <h3 className="text-body-3 font-semibold">Turn on {NAMING.displayName} AI</h3>
        <p className="mt-1 text-muted-foreground">Answers come from {model} by {provider}. To answer, it receives a text summary of {studio ? "the open dataset" : "the open project"}:</p>
      </div>
      {studio ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-hint">
          <li>Title, licence and label set</li>
          <li>File names and how they're grouped</li>
          <li>Each annotation's label, shape type and review status</li>
          <li>The workspace setup (tools, panels, label classes)</li>
        </ul>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-hint">
          <li>Title, tasks and what needs attention</li>
          <li>What you imported: kinds, counts, file and folder names, detected facts</li>
          <li>Proposals in Explore and the section you're in</li>
        </ul>
      )}
      <p className="rounded-lg bg-generic px-3 py-2">
        It never receives images, signals, video or any file contents unless you approve copying files into its private sandbox, and it can't change annotations or confirm anything. You approve every suggestion.
      </p>
      {!!project.heldFiles && (
        <p className="text-warning" data-testid="agent-consent-held">
          This project contains {project.heldFiles === 1 ? "a file" : `${project.heldFiles} files`} held for privacy review; the assistant won't see {project.heldFiles === 1 ? "it" : "them"}.
        </p>
      )}
      {project.restricted && (
        <p className="text-warning">
          {studio ? "This dataset's licence restricts redistribution. Only its metadata is shared, but check the licence allows that." : "This project's licence restricts redistribution: outside the Studio the assistant sees kinds, counts and statuses only, never file or folder names."}
        </p>
      )}
      <div className="mt-auto flex flex-col gap-2">
        <Button size="lg" onClick={onAccept}>Turn on for this browser</Button>
        <p className="text-caption text-hint">{studio ? "Annotation works the same with it off." : "Everything works the same with it off."}</p>
      </div>
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
