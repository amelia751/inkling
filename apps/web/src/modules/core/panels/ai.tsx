import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { AiIcon, CloseIcon, DocumentIcon, MoreIcon, NewChatIcon, RegionIcon, SearchIcon, SettingsIcon, StopIcon, SubmitIcon, TagIcon, WarningIcon } from "@/components/icons";
import { AssistantMessage, UserMessage } from "@/components/ai/thread";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Loader } from "@/components/ui/loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CARD_TOOLS, CARD_TOOL_NAMES, runCardTool } from "@/lib/agent/card-tools";
import { fetchAgentStatus } from "@/lib/agent/client";
import { buildAgentContext, turnContext } from "@/lib/agent/context";
import type { AgentStatus, ClientToolSpec, ProfileName } from "@/lib/agent/protocol";
import { installEnvironment, persistEnvironment } from "@/lib/environment-edits";
import { itemNoun, pluralWord } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AGENT_TOOLS, agentSystemPrompt, changedKeys, runAgentTool, type AgentHost as EnvHost } from "@/platform/agent";
import type { PanelProps } from "@/platform/module";
import { useAgent, type ChatMessage, type ClientToolOutcome } from "@/stores/agent";
import { useStudio } from "@/stores/studio";
import type { Project, StudioItem } from "@/types";

const EMPTY: ChatMessage[] = [];

const ENV_TITLES: Record<string, string> = {
  list_modules: "Listing modules",
  describe_contribution: "Reading contribution",
  get_environment: "Reading environment",
  validate_environment: "Validating environment",
  preview_environment: "Previewing environment",
  patch_environment: "Editing environment",
  run_command: "Running command",
};
const ENV_TOOLS: ClientToolSpec[] = AGENT_TOOLS.map((t) => ({ ...t, title: ENV_TITLES[t.name] }));

const PROFILES: { id: ProfileName; label: string; hint: string }[] = [
  { id: "assistant", label: "Dataset assistant", hint: "Questions, checks, label sets, docs" },
  { id: "environment-designer", label: "Environment designer", hint: "Also edits tools, panels, labels" },
  { id: "coder", label: "Coder (sandbox)", hint: "Also runs code in a private sandbox" },
];

/** One line for an environment tool's row (the model gets the full result). */
function envSummary(name: string, out: Awaited<ReturnType<typeof runAgentTool>>, change?: { summary: string }): string {
  const errors = Array.isArray(out.errors) ? out.errors.length : 0;
  if (!out.ok) return errors ? `${errors} error${errors === 1 ? "" : "s"}` : String(out.error ?? "Failed").slice(0, 80);
  const summary = out.summary as { tools?: unknown[]; labels?: { classes: unknown[] }[] } | undefined;
  switch (name) {
    case "list_modules":
      return `${(out.modules as unknown[] | undefined)?.length ?? 0} modules`;
    case "get_environment":
    case "validate_environment":
      return summary ? `${summary.tools?.length ?? 0} tools · ${summary.labels?.reduce((n, g) => n + g.classes.length, 0) ?? 0} label classes` : "Done";
    case "preview_environment":
      return "Valid";
    case "patch_environment":
      return change?.summary ?? "Applied";
    case "run_command":
      return out.handled ? "Done" : "No handler took it";
    default:
      return "Done";
  }
}

/** Tools the browser registers for a profile; the service checks them against its own allowlist. */
const clientToolsFor = (profile: ProfileName) => (profile === "assistant" ? CARD_TOOLS : [...CARD_TOOLS, ...ENV_TOOLS]);

/**
 * `inkling.core.panels.ai`: Inkling AI (ui.md §3, right sidebar), backed by the agent service
 * (apps/agent, pi + Daytona). The model gets a text snapshot of the dataset, never pixels. Tools
 * that act on the Studio run here, in the browser: environment edits are normal undoable `setEnv`
 * steps, cards only act on the expert's click, and consequential steps wait for approval.
 * Manual annotation never depends on this panel.
 */
export function AiPanel({ project, items, item }: PanelProps) {
  const toggleAi = useStudio((s) => s.toggleAi);
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
              <DropdownMenuContent align="end" className="w-60">
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
          <Button variant="ghost-secondary" size="icon" onClick={toggleAi} aria-label="Close assistant"><CloseIcon /></Button>
        </div>
      </header>

      {status.isLoading ? (
        <div className="flex flex-1 items-center justify-center"><Loader /></div>
      ) : !status.data?.configured ? (
        <NotConfigured status={status.data} />
      ) : !consent ? (
        <Consent provider={status.data.provider} model={status.data.model ?? ""} restricted={!!project.restricted} onAccept={() => setConsent(true)} />
      ) : (
        <Conversation project={project} items={items} item={item} thread={thread} status={status.data} running={running === project.id} busy={!!running && running !== project.id} />
      )}
    </aside>
  );
}

function Conversation({ project, items, item, thread, status, running, busy }: { project: Project; items: StudioItem[]; item?: StudioItem; thread: ChatMessage[]; status: AgentStatus; running: boolean; busy: boolean }) {
  const send = useAgent((s) => s.send);
  const profile = useAgent((s) => s.profile);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const author = `agent:${status.model ?? "model"}`;

  // The service asks for client tools by name; this runs them against the live Studio.
  useEffect(() => {
    const envHost: EnvHost & { change?: ClientToolOutcome["change"] } = {
      env: () => useStudio.getState().env,
      apply: async (env, summary) => {
        const before = useStudio.getState().env;
        await installEnvironment(env);
        envHost.change = { summary, keys: before ? changedKeys(before.source, env.source) : [] };
        await persistEnvironment(project.id, env, author);
      },
    };
    useAgent.getState().setHost({
      projectId: project.id,
      runTool: async (name, input): Promise<ClientToolOutcome> => {
        if (CARD_TOOL_NAMES.has(name)) return runCardTool(name, input, buildAgentContext(project, items));
        envHost.change = undefined;
        const out = await runAgentTool(name, input, envHost);
        return { ok: out.ok, output: out, summary: envSummary(name, out, envHost.change), change: out.ok ? envHost.change : undefined };
      },
    });
    useAgent.getState().reattach(project.id);
    return () => useAgent.getState().setHost(null);
  }, [project, items, author]);

  const ask = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    pinned.current = true;
    void send(project.id, t, {
      profile,
      clientTools: clientToolsFor(profile),
      catalogPrompt: profile === "assistant" ? undefined : agentSystemPrompt(),
      restricted: !!project.restricted,
      snapshot: buildAgentContext(project, items),
      context: turnContext(project, item, profile !== "assistant"),
    });
  };
  const retry = () => {
    const lastUser = [...thread].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    useAgent.setState((s) => ({ threads: { ...s.threads, [project.id]: thread.slice(0, thread.lastIndexOf(lastUser)) } }));
    ask(lastUser.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
  };
  const undo = async (messageId: string, partId: string) => {
    useStudio.getState().undoEnv();
    useAgent.getState().setPart(project.id, messageId, partId, { undone: true });
    const env = useStudio.getState().env;
    if (env) await persistEnvironment(project.id, env, "local-expert").catch(() => undefined);
    useAgent.getState().addNote(project.id, "(The expert undid your last environment change.)");
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
        data-testid="agent-log"
      >
        {thread.length === 0 ? (
          <EmptyState project={project} profile={profile} onAsk={ask} />
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
                  onRetry={i === thread.length - 1 && !running ? retry : undefined}
                  onUndo={(partId) => void undo(m.id, partId)}
                />
              ),
            )}
          </div>
        )}
      </div>
      <Composer project={project} item={item} profile={profile} running={running} busy={busy} onSend={ask} />
    </>
  );
}

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

function EmptyState({ project, profile, onAsk }: { project: Project; profile: ProfileName; onAsk: (t: string) => void }) {
  const noun = pluralWord(2, itemNoun(useStudio.getState().env ?? undefined));
  const prompts: { icon: Icon; text: string }[] = [
    { icon: SearchIcon, text: `Find unannotated ${noun}` },
    { icon: WarningIcon, text: "Explain validation warnings" },
    { icon: TagIcon, text: "Help me define labels" },
    { icon: RegionIcon, text: "Suggest a contour" },
    { icon: DocumentIcon, text: "Prepare dataset documentation" },
  ];
  if (profile !== "assistant") prompts.splice(2, 0, { icon: SettingsIcon, text: "Add a polygon tool and a “car” class in red" });
  if (profile === "coder") prompts.splice(0, 0, { icon: DocumentIcon, text: `Compute basic statistics for three ${noun} in the sandbox` });
  return (
    <div className="flex flex-col gap-5 px-3 pt-6 pb-4">
      <div className="px-1">
        <span className="mb-3 flex size-8 items-center justify-center rounded-lg bg-ai-tint text-ai-text"><AiIcon className="size-4" /></span>
        <h3 className="text-body-2 font-semibold">How can I help with this dataset?</h3>
        <p className="mt-1 text-muted-foreground">
          I can check progress, find gaps, explain warnings, and draft label definitions or documentation for {project.title}
          {profile === "assistant" ? "." : profile === "coder" ? ". I can also reshape this workspace and run analysis code in a private sandbox." : ". I can also reshape this workspace: tools, panels and labels."}
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

function Composer({ project, item, profile, running, busy, onSend }: { project: Project; item?: StudioItem; profile: ProfileName; running: boolean; busy: boolean; onSend: (t: string) => void }) {
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

  // While a run is active, a message steers it (the service queues it after the current step).
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
          placeholder={running ? "Add to the current request…" : profile === "assistant" ? `Ask about ${project.title}…` : "Ask Inkling to change this environment…"}
          aria-label="Message Inkling AI"
          className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-body outline-none placeholder:text-hint focus-visible:outline-none"
        />
        <div className="flex items-center gap-1.5 pr-1.5 pb-1.5 pl-2">
          <ContextChip project={project} item={item} selected={selected} />
          {running && !text.trim() ? (
            <Button variant="secondary" size="icon" className="ml-auto rounded-full" onClick={stop} aria-label="Stop generating"><StopIcon /></Button>
          ) : (
            <Button size="icon" className="ml-auto rounded-full" onClick={submit} disabled={!text.trim() || busy} aria-label="Send"><SubmitIcon /></Button>
          )}
        </div>
      </div>
      <p className="mt-1.5 px-1 text-caption text-hint">Sees a text summary only, never images. Can be wrong. Changes need your approval or can be undone.</p>
    </div>
  );
}

function ContextChip({ project, item, selected }: { project: Project; item?: StudioItem; selected: number }) {
  const noun = pluralWord(2, itemNoun(useStudio.getState().env ?? undefined));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex h-6 min-w-0 items-center gap-1 rounded-md bg-generic px-1.5 text-muted-foreground")} tabIndex={0}>
          <span className="truncate">{item?.name ?? project.title}</span>
          {selected > 0 && <span className="shrink-0 text-hint">· {selected} selected</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">Shared as text: {project.title}, its label set, {noun} names and annotation summaries.</TooltipContent>
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
        <li>The workspace setup (tools, panels, label classes)</li>
      </ul>
      <p className="rounded-lg bg-generic px-3 py-2">
        It never receives images, signals, video or any file contents unless you approve copying files into its private sandbox, and it can't change annotations. You approve every suggestion.
      </p>
      {restricted && <p className="text-warning">This dataset's licence restricts redistribution. Only its metadata is shared, but check the licence allows that.</p>}
      <div className="mt-auto flex flex-col gap-2">
        <Button size="lg" onClick={onAccept}>Turn on for this browser</Button>
        <p className="text-caption text-hint">Annotation works the same with it off.</p>
      </div>
    </div>
  );
}

function NotConfigured({ status }: { status: AgentStatus | undefined }) {
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
      <p className="text-muted-foreground">Everything else in the Studio works without it.</p>
    </div>
  );
}
