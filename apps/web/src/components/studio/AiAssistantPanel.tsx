import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { AiIcon, CloseIcon, DocumentIcon, MoreIcon, NewChatIcon, RegionIcon, SearchIcon, StopIcon, SubmitIcon, TagIcon, WarningIcon } from "@/components/icons";
import { AssistantMessage, UserMessage } from "@/components/ai/thread";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Loader } from "@/components/ui/loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fetchAgentStatus } from "@/lib/agent/client";
import { buildAgentContext } from "@/lib/agent/context";
import { ITEM_NOUN, pluralWord } from "@/lib/format";
import { projectItems } from "@/lib/items";
import { cn } from "@/lib/utils";
import { useAgent, type ChatMessage } from "@/stores/agent";
import { useStudio } from "@/stores/studio";
import type { Project, StudioItem } from "@/types";
import { adapterFor } from "@/viewers/registry";

const EMPTY: ChatMessage[] = [];

/**
 * Inkling AI (ui.md §3, right sidebar). Streams from the agent runtime over SSE.
 * The model gets a text snapshot of the dataset, never pixels; anything that would
 * change annotations arrives as a card the expert approves.
 */
export function AiAssistantPanel({ project, item }: { project: Project; item?: StudioItem }) {
  const toggleAi = useStudio((s) => s.toggleAi);
  const status = useQuery({ queryKey: ["agent-status"], queryFn: fetchAgentStatus, staleTime: 60_000, retry: false });
  const consent = useAgent((s) => s.consent);
  const setConsent = useAgent((s) => s.setConsent);
  const thread = useAgent((s) => s.threads[project.id] ?? EMPTY);
  const running = useAgent((s) => s.running);
  const reset = useAgent((s) => s.reset);
  const ready = !!status.data?.configured && consent;

  return (
    <aside className="flex h-full min-w-0 flex-col bg-background" aria-label="Inkling AI">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <AiIcon className="size-4 shrink-0 text-ai-text" />
        <h2 className="truncate font-semibold">Inkling AI</h2>
        {status.data?.model && <Badge theme="clear" className="min-w-0 truncate">{status.data.model}</Badge>}
        <div className="ml-auto flex shrink-0 items-center">
          {ready && thread.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost-secondary" size="icon" onClick={() => reset(project.id)} aria-label="New chat"><NewChatIcon /></Button>
              </TooltipTrigger>
              <TooltipContent>New chat</TooltipContent>
            </Tooltip>
          )}
          {consent && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost-secondary" size="icon" aria-label="Assistant options"><MoreIcon /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!thread.length} onSelect={() => reset(project.id)}>Clear conversation</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => setConsent(false)}>Stop sharing with {status.data?.provider ?? "the model"}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="ghost-secondary" size="icon" onClick={toggleAi} aria-label="Close assistant"><CloseIcon /></Button>
        </div>
      </header>

      {status.isLoading ? (
        <div className="flex flex-1 items-center justify-center"><Loader /></div>
      ) : !status.data?.configured ? (
        <NotConfigured />
      ) : !consent ? (
        <Consent provider={status.data.provider} model={status.data.model ?? ""} restricted={!!project.restricted} onAccept={() => setConsent(true)} />
      ) : (
        <Conversation project={project} item={item} thread={thread} running={running === project.id} busy={!!running} />
      )}
    </aside>
  );
}

function Conversation({ project, item, thread, running, busy }: { project: Project; item?: StudioItem; thread: ChatMessage[]; running: boolean; busy: boolean }) {
  const items = useMemo(() => projectItems(project), [project]);
  const tools = useMemo(() => adapterFor(project)?.tools ?? [], [project]);
  const send = useAgent((s) => s.send);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const ask = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    pinned.current = true;
    void send(project.id, t, buildAgentContext(project, items, tools));
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

  return (
    <>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {thread.length === 0 ? (
          <EmptyState project={project} onAsk={ask} />
        ) : (
          <div className="flex flex-col gap-5 px-3 py-4">
            {thread.map((m, i) =>
              m.role === "user" ? (
                <UserMessage key={m.id} message={m} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  message={m}
                  streaming={running && i === thread.length - 1}
                  projectId={project.id}
                  project={project}
                  items={items}
                  onRetry={i === thread.length - 1 && !busy ? retry : undefined}
                />
              ),
            )}
          </div>
        )}
      </div>
      <Composer project={project} item={item} running={running} busy={busy} onSend={ask} />
    </>
  );
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

function EmptyState({ project, onAsk }: { project: Project; onAsk: (t: string) => void }) {
  const noun = pluralWord(2, ITEM_NOUN[project.viewer]);
  const prompts: { icon: Icon; text: string }[] = [
    { icon: TagIcon, text: "Help me define labels" },
    { icon: RegionIcon, text: "Suggest a contour" },
    { icon: SearchIcon, text: `Find unannotated ${noun}` },
    { icon: WarningIcon, text: "Explain validation warnings" },
    { icon: DocumentIcon, text: "Prepare dataset documentation" },
  ];
  return (
    <div className="flex flex-col gap-5 px-3 pt-6 pb-4">
      <div className="px-1">
        <span className="mb-3 flex size-8 items-center justify-center rounded-lg bg-ai-tint text-ai-text"><AiIcon className="size-4" /></span>
        <h3 className="text-body-2 font-semibold">How can I help with this dataset?</h3>
        <p className="mt-1 text-muted-foreground">
          I can check progress, find gaps, explain warnings, and draft label definitions or documentation for {project.title}.
        </p>
      </div>
      <ul className="flex flex-col">
        {prompts.map(({ icon: I, text }) => (
          <li key={text}>
            <button onClick={() => onAsk(text)} className="group flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-generic">
              <I className="size-4 shrink-0 text-hint group-hover:text-complementary" />
              <span className="truncate">{text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Composer({ project, item, running, busy, onSend }: { project: Project; item?: StudioItem; running: boolean; busy: boolean; onSend: (t: string) => void }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const stop = useAgent((s) => s.stop);
  const selected = useStudio((s) => s.selectedIds.length);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const submit = () => {
    if (!text.trim() || busy) return;
    onSend(text);
    setText("");
  };

  return (
    <div className="shrink-0 px-3 pt-1 pb-3">
      <div className="rounded-xl border border-border bg-background transition-colors focus-within:border-border-hover has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-[var(--g-line-focus)] has-[textarea:focus-visible]:-outline-offset-1">
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
          rows={1}
          placeholder={`Ask about ${project.title}…`}
          aria-label="Message Inkling AI"
          className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-body outline-none placeholder:text-hint focus-visible:outline-none"
        />
        <div className="flex items-center gap-1.5 pr-1.5 pb-1.5 pl-2">
          <ContextChip project={project} item={item} selected={selected} />
          {running ? (
            <Button variant="secondary" size="icon" className="ml-auto rounded-full" onClick={stop} aria-label="Stop generating"><StopIcon /></Button>
          ) : (
            <Button size="icon" className="ml-auto rounded-full" onClick={submit} disabled={!text.trim() || busy} aria-label="Send"><SubmitIcon /></Button>
          )}
        </div>
      </div>
      <p className="mt-1.5 px-1 text-caption text-hint">Sees a text summary only, never images. Can be wrong. Changes need your approval.</p>
    </div>
  );
}

function ContextChip({ project, item, selected }: { project: Project; item?: StudioItem; selected: number }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex h-6 min-w-0 items-center gap-1 rounded-md bg-generic px-1.5 text-muted-foreground")} tabIndex={0}>
          <span className="truncate">{item?.name ?? project.title}</span>
          {selected > 0 && <span className="shrink-0 text-hint">· {selected} selected</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        Shared as text: {project.title}, its label set, {pluralWord(2, ITEM_NOUN[project.viewer])} names and annotation summaries.
      </TooltipContent>
    </Tooltip>
  );
}

function Consent({ provider, model, restricted, onAccept }: { provider: string; model: string; restricted: boolean; onAccept: () => void }) {
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pt-6 pb-4">
      <span className="flex size-8 items-center justify-center rounded-lg bg-ai-tint text-ai-text"><AiIcon className="size-4" /></span>
      <div>
        <h3 className="text-body-2 font-semibold">Turn on Inkling AI</h3>
        <p className="mt-1 text-muted-foreground">Answers come from {model} by {provider}. To answer, it receives a text summary of the open dataset:</p>
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-5 marker:text-hint">
        <li>Title, licence and label set</li>
        <li>File names and how they're grouped</li>
        <li>Each annotation's label, shape type and review status</li>
      </ul>
      <p className="rounded-lg bg-generic px-3 py-2">
        It never receives images, signals, video or any file contents, and it can't change annotations. You approve every suggestion.
      </p>
      {restricted && <p className="text-warning">This dataset's licence restricts redistribution. Only its metadata is shared, but check the licence allows that.</p>}
      <div className="mt-auto flex flex-col gap-2">
        <Button size="lg" onClick={onAccept}>Turn on for this browser</Button>
        <p className="text-caption text-hint">Annotation works the same with it off.</p>
      </div>
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="flex flex-1 flex-col gap-3 px-4 pt-6">
      <span className="flex size-8 items-center justify-center rounded-lg bg-generic text-hint"><AiIcon className="size-4" /></span>
      <h3 className="text-body-2 font-semibold">No model connected</h3>
      <p className="text-muted-foreground">
        Set <code className="rounded-xs bg-generic px-1 font-mono text-code">OPENAI_API_KEY</code> (and optionally <code className="rounded-xs bg-generic px-1 font-mono text-code">OPENAI_MODEL</code>) for the dev server, then restart it.
      </p>
      <p className="text-muted-foreground">Everything else in the Studio works without it.</p>
    </div>
  );
}
