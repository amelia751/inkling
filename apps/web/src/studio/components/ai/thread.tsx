import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, DoneIcon, ErrorIcon, FileIcon, InfoIcon, UndoIcon, WarningIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Spinner } from "@studio/ui/ui/spinner";
import { InstallReview } from "@/studio/components/plugins/InstallReview";
import { artifactUrl } from "@/studio/lib/agent/client";
import { approveInstall, getInstallRequest, rejectInstall, type InstallRequest } from "@/studio/lib/plugins-api";
import { formatBytes } from "@/studio/lib/format";
import { cn } from "@studio/ui/utils";
import { useAgent, type ChatMessage, type MessagePart } from "@/studio/stores/agent";
import type { Project, StudioItem } from "@studio/contracts";
import { AgentCardView } from "./cards";
import { Markdown } from "./markdown";

const PAST: Record<string, string> = {
  Reading: "Read",
  Listing: "Listed",
  Checking: "Checked",
  Preparing: "Prepared",
  Drafting: "Drafted",
  Writing: "Wrote",
  Picking: "Picked",
  Finding: "Found",
  Editing: "Edited",
  Running: "Ran",
  Validating: "Validated",
  Previewing: "Previewed",
  Uploading: "Uploaded",
  Exporting: "Exported",
};
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
  /** Undo an environment change the agent made (the Studio's env undo). */
  onUndo?: (partId: string) => void;
}

const SANDBOX_TEXT: Record<string, string> = {
  creating: "Starting a sandbox…",
  ready: "Sandbox ready",
  resumed: "Sandbox resumed",
  stopped: "Sandbox stopped",
  deleted: "Sandbox deleted",
  unavailable: "Sandbox unavailable; a new one starts on the next step",
};

export function AssistantMessage({ message, streaming, projectId, project, items, onRetry, onUndo }: AssistantProps) {
  const setCardState = useAgent((s) => s.setCardState);
  const decide = useAgent((s) => s.decide);
  const groups = groupParts(message.parts);
  const idle = streaming && (message.parts.length === 0 || message.parts[message.parts.length - 1].type === "card");

  return (
    <div className="flex flex-col gap-2.5">
      {groups.map((g, i) => {
        if (g.kind === "tools") return <ToolSteps key={i} parts={g.parts} live={streaming} />;
        const p = g.part;
        if (p.type === "text") return <Markdown key={i} text={p.text} />;
        if (p.type === "reasoning") return <Reasoning key={i} text={p.text} live={streaming && i === groups.length - 1} />;
        if (p.type === "approval")
          return p.detail?.kind === "plugin-install" ? (
            <InstallApprovalCard key={i} part={p} onDecide={(d) => decide(projectId, message.id, p.id, d)} />
          ) : (
            <ApprovalCard key={i} part={p} onDecide={(d) => decide(projectId, message.id, p.id, d)} />
          );
        if (p.type === "change") return <ChangeCard key={i} part={p} onUndo={onUndo && (() => onUndo(p.id))} />;
        if (p.type === "artifact")
          return (
            <a key={i} href={artifactUrl(p.id)} download={p.name} className="flex items-center gap-2 self-start rounded-md border border-border px-2.5 py-1.5 hover:bg-generic">
              <FileIcon className="size-3.5 shrink-0 text-hint" />
              <span className="truncate">{p.name}</span>
              <span className="shrink-0 text-hint">{formatBytes(p.bytes)}</span>
            </a>
          );
        if (p.type === "status") return <p key={i} className="text-caption text-hint">{p.text}</p>;
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
      {message.sandbox && (streaming || message.sandbox === "unavailable") && (
        <p className={cn("text-caption", message.sandbox === "unavailable" ? "text-warning" : "text-hint")} data-testid="agent-sandbox">
          {SANDBOX_TEXT[message.sandbox] ?? message.sandbox}
        </p>
      )}
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
        <p
          className="text-caption text-hint"
          title={`${message.usage.inputTokens.toLocaleString()} tokens in (${(message.usage.cachedTokens ?? 0).toLocaleString()} cached) · ${message.usage.outputTokens.toLocaleString()} out`}
          data-testid="agent-usage"
        >
          {message.model} · {(message.usage.inputTokens + (message.usage.cachedTokens ?? 0) + message.usage.outputTokens).toLocaleString()} tokens
          {message.usage.costUsd > 0 && ` · $${message.usage.costUsd < 0.01 ? message.usage.costUsd.toFixed(4) : message.usage.costUsd.toFixed(2)}`}
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
      {part.output && (running || open) && (
        <pre className="mt-1 mb-1.5 ml-5.5 max-h-40 overflow-auto rounded-md bg-generic px-2.5 py-1.5 font-mono text-code whitespace-pre-wrap text-muted-foreground" data-testid="agent-tool-output">
          {part.output.length > 4000 ? `…${part.output.slice(-4000)}` : part.output}
        </pre>
      )}
    </li>
  );
}

/** Consequential steps wait here; nothing runs until the expert approves. */
function ApprovalCard({ part, onDecide }: { part: Extract<MessagePart, { type: "approval" }>; onDecide: (d: "approve" | "reject") => void }) {
  const pending = part.state === "pending";
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background" data-testid="agent-approval">
      <header className="flex items-start gap-2 px-3 pt-2.5 pb-2">
        <WarningIcon className="mt-px size-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <h4 className="font-semibold">Approve this step?</h4>
          <p className="text-muted-foreground">{part.summary}</p>
        </div>
      </header>
      <pre className="mx-3 mb-2 max-h-28 overflow-auto rounded-md bg-generic px-2.5 py-1.5 font-mono text-code whitespace-pre-wrap text-muted-foreground">{part.inputPreview}</pre>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
        {pending ? (
          <>
            <Button variant="outline" size="sm" onClick={() => onDecide("reject")}>Reject</Button>
            <Button size="sm" onClick={() => onDecide("approve")}>Approve</Button>
          </>
        ) : (
          <span className={cn("flex h-6 items-center gap-1", part.state === "approved" ? "text-positive" : "text-muted-foreground")}>
            {part.state === "approved" ? <DoneIcon className="size-3.5" /> : <InfoIcon className="size-3.5" />}
            {part.state === "approved" ? "Approved" : part.state === "rejected" ? "Rejected" : "Expired"}
          </span>
        )}
      </footer>
    </section>
  );
}

/**
 * The agent asked to install a plugin (request_install_approval). Approving happens in the
 * install review, as the user: the Studio calls the kernel's approve itself (agent tokens can't),
 * then tells the agent. There is no one-click approve here on purpose.
 */
function InstallApprovalCard({ part, onDecide }: { part: Extract<MessagePart, { type: "approval" }>; onDecide: (d: "approve" | "reject") => void }) {
  const qc = useQueryClient();
  const detail = part.detail!;
  const [request, setRequest] = useState<InstallRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = part.state === "pending";
  const open = async () => {
    setError(null);
    try {
      setRequest(await getInstallRequest(detail.workspaceId, detail.requestId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const finish = async (decision: "approve" | "reject", grant: string[] = []) => {
    setBusy(true);
    setError(null);
    try {
      if (decision === "approve") await approveInstall(detail.workspaceId, detail.requestId, grant);
      else await rejectInstall(detail.workspaceId, detail.requestId).catch(() => undefined);
      setRequest(null);
      onDecide(decision);
      // The Studio re-reads the workspace state and activates the new plugin without a reload.
      void qc.invalidateQueries({ queryKey: ["workspace", detail.workspaceId] });
      void qc.invalidateQueries({ queryKey: ["plugins", detail.workspaceId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background" data-testid="agent-install-approval">
      <header className="flex items-start gap-2 px-3 pt-2.5 pb-2">
        <WarningIcon className="mt-px size-4 shrink-0 text-warning" />
        <div className="min-w-0">
          <h4 className="font-semibold">Review a plugin install</h4>
          <p className="text-muted-foreground">The agent wants to install a plugin in this workspace. Review what it adds before approving.</p>
          {error && <p className="mt-1 text-danger" role="alert">{error}</p>}
        </div>
      </header>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
        {pending ? (
          <>
            <Button variant="outline" size="sm" onClick={() => void finish("reject")} disabled={busy}>Reject</Button>
            <Button size="sm" onClick={() => void open()} disabled={busy} data-testid="open-install-review">Review install</Button>
          </>
        ) : (
          <span className={cn("flex h-6 items-center gap-1", part.state === "approved" ? "text-positive" : "text-muted-foreground")}>
            {part.state === "approved" ? <DoneIcon className="size-3.5" /> : <InfoIcon className="size-3.5" />}
            {part.state === "approved" ? "Installed" : part.state === "rejected" ? "Rejected" : "Expired"}
          </span>
        )}
      </footer>
      <InstallReview
        request={request}
        open={!!request}
        busy={busy}
        onApprove={(grant) => void finish("approve", grant)}
        onReject={() => void finish("reject")}
        onOpenChange={(o) => !o && setRequest(null)}
      />
    </section>
  );
}

/** An environment edit the agent applied: one Studio undo step. */
function ChangeCard({ part, onUndo }: { part: Extract<MessagePart, { type: "change" }>; onUndo?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-prov-ai/10 px-2.5 py-1.5 text-xs" data-testid="agent-change">
      <div className="min-w-0 flex-1">
        <div className={part.undone ? "text-muted-foreground line-through" : "font-medium"}>Agent changed: {part.summary}</div>
        {part.keys.length > 0 && <div className="text-muted-foreground">{part.keys.join(", ")}</div>}
      </div>
      {!part.undone && onUndo && (
        <button onClick={onUndo} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-generic hover:text-foreground">
          <UndoIcon className="h-3 w-3" /> Undo
        </button>
      )}
    </div>
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
