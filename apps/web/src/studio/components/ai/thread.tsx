import { useState } from "react";
import { ChevronDownIcon, DoneIcon, ErrorIcon } from "@studio/studio-ui/icons";
import { Button } from "@studio/studio-ui/ui/button";
import { Spinner } from "@studio/studio-ui/ui/spinner";
import { cn } from "@studio/studio-ui/utils";
import { useAgent, type ChatMessage, type MessagePart } from "@/studio/stores/agent";
import type { Project, StudioItem } from "@studio/plugin-contracts/types";
import { AgentCardView } from "./cards";
import { Markdown } from "./markdown";

const PAST: Record<string, string> = { Reading: "Read", Listing: "Listed", Checking: "Checked", Preparing: "Prepared", Drafting: "Drafted", Writing: "Wrote", Picking: "Picked", Finding: "Found" };
const pastTense = (title: string) => title.replace(/^(\w+)/, (w) => PAST[w] ?? w);

export function UserMessage({ message }: { message: ChatMessage }) {
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  return <div className="ml-10 self-end whitespace-pre-wrap rounded-xl rounded-br-xs bg-generic px-3 py-2 break-words">{text}</div>;
}

interface AssistantProps {
  message: ChatMessage;
  streaming: boolean;
  projectId: string;
  project: Project;
  items: StudioItem[];
  onRetry?: () => void;
}

export function AssistantMessage({ message, streaming, projectId, project, items, onRetry }: AssistantProps) {
  const setCardState = useAgent((s) => s.setCardState);
  const groups = groupParts(message.parts);
  const idle = streaming && (message.parts.length === 0 || message.parts[message.parts.length - 1].type === "card");

  return (
    <div className="flex flex-col gap-2.5">
      {groups.map((g, i) => {
        if (g.kind === "tools") return <ToolSteps key={i} parts={g.parts} live={streaming} />;
        const p = g.part;
        if (p.type === "text") return <Markdown key={i} text={p.text} />;
        if (p.type === "reasoning") return <Reasoning key={i} text={p.text} live={streaming && i === groups.length - 1} />;
        return (
          <AgentCardView
            key={i}
            card={p.card}
            state={p.state}
            setState={(state) => setCardState(projectId, message.id, p.id, state)}
            project={project}
            items={items}
          />
        );
      })}
      {idle && <p className="shimmer-text self-start">Thinking…</p>}
      {message.error && (
        <div className="flex items-start gap-2 rounded-lg bg-danger-tint px-3 py-2 text-danger">
          <ErrorIcon className="mt-px size-4 shrink-0" />
          <p className="min-w-0 flex-1 break-words">{message.error}</p>
          {onRetry && <Button variant="ghost" size="xs" className="-my-0.5 text-danger" onClick={onRetry}>Retry</Button>}
        </div>
      )}
      {message.stopped && <p className="text-hint">Stopped.</p>}
      {!streaming && message.usage && (
        <p className="text-caption text-hint" title={`${message.usage.inputTokens.toLocaleString()} tokens in · ${message.usage.outputTokens.toLocaleString()} out`}>
          {message.model} · {(message.usage.inputTokens + message.usage.outputTokens).toLocaleString()} tokens
        </p>
      )}
    </div>
  );
}

type Group = { kind: "tools"; parts: Extract<MessagePart, { type: "tool" }>[] } | { kind: "part"; part: Exclude<MessagePart, { type: "tool" }> };

/** Consecutive tool calls render as one compact step list. */
function groupParts(parts: MessagePart[]): Group[] {
  const out: Group[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.type === "tool") {
      if (last?.kind === "tools") last.parts.push(p);
      else out.push({ kind: "tools", parts: [p] });
    } else out.push({ kind: "part", part: p });
  }
  return out;
}

function ToolSteps({ parts, live }: { parts: Extract<MessagePart, { type: "tool" }>[]; live: boolean }) {
  return (
    <ul className="flex flex-col">
      {parts.map((p) => <ToolStep key={p.id} part={p} live={live} />)}
    </ul>
  );
}

function ToolStep({ part, live }: { part: Extract<MessagePart, { type: "tool" }>; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = part.status === "running" && live;
  const failed = part.status === "error" || (part.status === "running" && !live);
  return (
    <li>
      <button
        onClick={() => part.input !== undefined && setOpen(!open)}
        className={cn("group flex h-6 w-full min-w-0 items-center gap-2 text-left text-muted-foreground", part.input !== undefined && "hover:text-foreground")}
        aria-expanded={part.input !== undefined ? open : undefined}
      >
        {running ? <Spinner className="size-3.5" /> : failed ? <ErrorIcon className="size-3.5 shrink-0 text-danger" /> : <DoneIcon className="size-3.5 shrink-0 text-hint" />}
        <span className={cn("min-w-0 truncate", running && "shimmer-text")}>
          {running ? `${part.title}…` : pastTense(part.title)}
          {part.summary && <span className="text-hint"> · {part.summary}</span>}
        </span>
        {part.input !== undefined && <ChevronDownIcon className={cn("ml-auto size-3 shrink-0 text-hint opacity-0 transition group-hover:opacity-100", open && "rotate-180 opacity-100")} />}
      </button>
      {open && (
        <pre className="mt-1 mb-1.5 ml-5.5 max-h-48 overflow-auto rounded-md bg-generic px-2.5 py-1.5 font-mono text-code text-muted-foreground">
          {JSON.stringify(part.input, null, 2)}
        </pre>
      )}
    </li>
  );
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex h-6 items-center gap-1.5 text-muted-foreground hover:text-foreground" aria-expanded={open}>
        <span className={cn(live && "shimmer-text")}>{live ? "Thinking…" : "Thought process"}</span>
        <ChevronDownIcon className={cn("size-3 transition", open && "rotate-180")} />
      </button>
      {open && <Markdown text={text} className="mt-1 border-l-2 border-border pl-3 text-muted-foreground" />}
    </div>
  );
}
