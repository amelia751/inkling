import { Fragment, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { ChevronDownIcon, CloseIcon, DoneIcon, ErrorIcon, FileIcon, InfoIcon, RetryIcon, UndoIcon, WarningIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Spinner } from "@studio/ui/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { NAMING } from "@studio/contracts/naming";
import { InstallReview } from "@/studio/components/plugins/InstallReview";
import { artifactUrl } from "@/studio/lib/agent/client";
import { approveInstall, getInstallRequest, rejectInstall, type InstallRequest } from "@/studio/lib/plugins-api";
import { formatBytes } from "@/studio/lib/format";
import { cn } from "@studio/ui/utils";
import { useAgent, type ChatMessage, type MessagePart } from "@/studio/stores/agent";
import type { ApprovalDetail } from "@studio/agent-protocol";
import { exploreUrl, trashUrl } from "@/studio/lib/routes";
import { postUndo, restoreTrashBatch } from "@/studio/lib/files/api";
import { AgentCardView, type StudioCardContext } from "./cards";
import { BootCard, OfferCard } from "./boot-card";
import { CopyButton } from "./copy-button";
import { Markdown } from "./markdown";
import { DropCard } from "@/studio/core/drops";

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

const textOf = (message: ChatMessage) =>
  message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");

/** "INKLING AI" over a pending or failed reply, as Nebius Echo labels its own. */
function Meta() {
  return <div className="mb-1 text-caption tracking-[0.4px] text-muted-foreground uppercase">{NAMING.displayName} AI</div>;
}

/** Waiting for the reply: the label over a spinner. */
function Pending({ queued = false }: { queued?: boolean }) {
  return (
    <div className="self-start py-1" role="status" aria-label={queued ? `${NAMING.displayName} AI is queued` : `${NAMING.displayName} AI is working`}>
      <Meta />
      {queued ? <p className="text-hint">Queued</p> : <Spinner size="s" />}
    </div>
  );
}

export function UserMessage({ message, projectId, canEdit = true }: { message: ChatMessage; projectId?: string; canEdit?: boolean }) {
  const text = textOf(message);
  const drops = message.parts.filter((p): p is Extract<MessagePart, { type: "drop" }> => p.type === "drop");
  return (
    <>
      {projectId &&
        drops.map((d) => (
          <div key={d.id} className="w-full max-w-[88%] self-end" data-testid="user-drop">
            <DropCard dropId={d.id} projectId={projectId} canEdit={canEdit} />
          </div>
        ))}
      {text && (
        <div className="group relative max-w-[88%] self-end rounded-xl bg-generic p-3 text-chat/5 break-words whitespace-pre-wrap">
          {text}
          <CopyButton text={text} label="Copy message" className="absolute top-2.5 right-2.5 bg-float-hover opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
        </div>
      )}
    </>
  );
}

interface AssistantProps {
  message: ChatMessage;
  streaming: boolean;
  /** The newest message keeps its actions visible; older ones show them on hover. */
  latest: boolean;
  projectId: string;
  /** In the Studio: the dataset its cards act on (outside it, Studio-only cards say so). */
  studio?: StudioCardContext;
  onRetry?: () => void;
  /** Undo an environment change the agent made (the Studio's env undo). */
  onUndo?: (partId: string) => void;
}

const SANDBOX_TEXT: Record<string, string> = {
  creating: "Starting a sandbox",
  ready: "Sandbox ready",
  resumed: "Sandbox resumed",
  stopped: "Sandbox stopped",
  deleted: "Sandbox deleted",
  unavailable: "Sandbox unavailable; a new one starts on the next step",
};

export function AssistantMessage({ message, streaming, latest, projectId, studio, onRetry, onUndo }: AssistantProps) {
  const setCardState = useAgent((s) => s.setCardState);
  const decide = useAgent((s) => s.decide);
  const groups = groupParts(message.parts);
  // The message exists from the moment you send, before the run starts streaming into it.
  const waiting = latest && message.parts.length === 0 && !message.error && !message.stopped && !message.usage;
  const lastType = message.parts[message.parts.length - 1]?.type;
  const idle = waiting || (streaming && (lastType === "card" || lastType === "boot"));
  const text = textOf(message);

  return (
    <div className="group/message flex flex-col gap-3">
      {groups.map((g, i) => {
        if (g.kind === "tools")
          return (
            <Fragment key={i}>
              <ToolSteps parts={g.parts} live={streaming} />
              {g.parts.map((t) => {
                const offer = studioOffer(t);
                if (offer) return <OfferCard key={t.id} projectId={projectId} messageId={message.id} offerId={t.id} offer={offer} />;
                const trashed = movedToTrash(t);
                return trashed && <TrashCard key={t.id} projectId={projectId} name={t.name} batchId={trashed} />;
              })}
            </Fragment>
          );
        const p = g.part;
        if (p.type === "boot") return <BootCard key={i} bootId={p.id} />;
        if (p.type === "text") return <Markdown key={i} text={p.text} className="text-chat" />;
        if (p.type === "reasoning") return <Reasoning key={i} text={p.text} live={streaming && i === groups.length - 1} />;
        if (p.type === "approval")
          return p.detail?.kind === "plugin-install" ? (
            <InstallApprovalCard key={i} part={p} onDecide={(d) => decide(projectId, message.id, p.id, d)} />
          ) : (
            <ApprovalCard key={i} part={p} projectId={projectId} onDecide={(d) => decide(projectId, message.id, p.id, d)} />
          );
        if (p.type === "change") return <ChangeCard key={i} part={p} onUndo={onUndo && (() => onUndo(p.id))} />;
        if (p.type === "artifact")
          return (
            <a key={i} href={artifactUrl(p.id)} download={p.name} className="flex items-center gap-2 self-start rounded-lg border border-border bg-background px-3 py-2 hover:bg-generic">
              <FileIcon className="size-4 shrink-0 text-hint" />
              <span className="truncate">{p.name}</span>
              <span className="shrink-0 text-hint">{formatBytes(p.bytes)}</span>
            </a>
          );
        if (p.type === "status") return <p key={i} className="text-hint">{p.text}</p>;
        if (p.type === "drop") return null; // shown on the user message
        return (
          <AgentCardView
            key={i}
            card={p.card}
            state={p.state}
            setState={(state) => setCardState(projectId, message.id, p.id, state)}
            projectId={projectId}
            studio={studio}
          />
        );
      })}
      {message.sandbox && (streaming || message.sandbox === "unavailable") && (
        <p className={cn(message.sandbox === "unavailable" ? "text-warning" : "text-hint")} data-testid="agent-sandbox">
          {SANDBOX_TEXT[message.sandbox] ?? message.sandbox}
        </p>
      )}
      {idle && <Pending queued={message.runStatus === "queued"} />}
      {message.error && (
        <div className="self-start" role="alert">
          <Meta />
          <p className="text-chat break-words text-muted-foreground italic">{message.error}</p>
          {onRetry && (
            <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
              <RetryIcon /> Retry
            </Button>
          )}
        </div>
      )}
      {message.stopped && <p className="text-hint">Stopped.</p>}
      {!streaming && (text || message.usage) && (
        <div className={cn("-mt-0.5 flex h-6 items-center gap-1 text-muted-foreground transition-opacity", !latest && "opacity-0 group-hover/message:opacity-100 focus-within:opacity-100")}>
          {text && <CopyButton text={text} label="Copy response" size="icon-sm" />}
          {onRetry && !message.error && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost-secondary" size="icon-sm" className="rounded-full" onClick={onRetry} aria-label="Regenerate response">
                  <RetryIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Regenerate response</TooltipContent>
            </Tooltip>
          )}
          {message.usage && (
            <span
              className="ml-auto truncate pl-2 text-caption text-hint"
              title={`${message.usage.inputTokens.toLocaleString()} tokens in (${(message.usage.cachedTokens ?? 0).toLocaleString()} cached) · ${message.usage.outputTokens.toLocaleString()} out`}
              data-testid="agent-usage"
            >
              {message.model} · {(message.usage.inputTokens + (message.usage.cachedTokens ?? 0) + message.usage.outputTokens).toLocaleString()} tokens
              {message.usage.costUsd > 0 && ` · $${message.usage.costUsd < 0.01 ? message.usage.costUsd.toFixed(4) : message.usage.costUsd.toFixed(2)}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** An `offer_studio` call that finished: its arguments are the offer (todo11 D5), rendered as a Create button. */
function studioOffer(t: Extract<MessagePart, { type: "tool" }>): { preset: string; title: string; reason?: string } | null {
  if (t.name !== "offer_studio" || t.status !== "done" || !t.input || typeof t.input !== "object") return null;
  const o = t.input as { preset?: unknown; title?: unknown; reason?: unknown };
  return typeof o.preset === "string" && typeof o.title === "string" ? { preset: o.preset, title: o.title, ...(typeof o.reason === "string" ? { reason: o.reason } : {}) } : null;
}

/** todo16 D8: a catalogue trash tool's result carries the batch to undo. */
function movedToTrash(t: Extract<MessagePart, { type: "tool" }>): string | null {
  if (t.status !== "done" || !t.output) return null;
  try {
    const o = JSON.parse(t.output) as { movedToTrash?: unknown; batchId?: unknown };
    return o.movedToTrash === true && typeof o.batchId === "string" ? o.batchId : null;
  } catch {
    return null;
  }
}

const TRASHED_WHAT: Record<string, string> = { source_trash: "files", dataset_delete: "a dataset", collection_delete: "a collection", studio_delete: "a Studio", project_delete: "the project" };

/** "Moved to Trash: files · Undo · Open Trash" (todo16 D8). */
function TrashCard({ projectId, name, batchId }: { projectId: string; name: string; batchId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "undone" | "failed">("idle");
  const qc = useQueryClient();
  const undo = async () => {
    setState("busy");
    try {
      await (name === "source_trash" ? postUndo(projectId, batchId) : restoreTrashBatch(projectId, batchId));
      await qc.invalidateQueries();
      setState("undone");
    } catch {
      setState("failed");
    }
  };
  return (
    <div className="flex items-center gap-2 self-start rounded-lg border border-border bg-background px-3 py-2" data-testid="agent-trash-card">
      <span>{state === "undone" ? "Restored" : `Moved to Trash: ${TRASHED_WHAT[name] ?? "items"}`}</span>
      {state !== "undone" && (
        <Button variant="ghost" size="sm" onClick={undo} disabled={state === "busy"} data-testid="agent-trash-undo">
          <UndoIcon /> Undo
        </Button>
      )}
      <Link to={trashUrl(projectId)} className="text-brand underline-offset-2 hover:underline" data-testid="agent-trash-open">
        Open Trash
      </Link>
      {state === "failed" && <span className="text-warning">Couldn't undo; restore it from the Trash</span>}
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
    <ul className="flex flex-col gap-0.5">
      {parts.map((p) => <ToolStep key={p.id} part={p} live={live} />)}
    </ul>
  );
}

function ToolStep({ part, live }: { part: Extract<MessagePart, { type: "tool" }>; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = part.status === "running" && live;
  const failed = part.status === "error" || (part.status === "running" && !live);
  const expandable = part.input !== undefined || !!part.output;
  return (
    <li>
      <button
        onClick={() => expandable && setOpen(!open)}
        className={cn("group flex h-7 w-full min-w-0 items-center gap-2 rounded-md text-left text-muted-foreground", expandable && "hover:text-foreground")}
        aria-expanded={expandable ? open : undefined}
      >
        {running ? <Spinner className="size-4" /> : failed ? <ErrorIcon className="size-4 shrink-0 text-danger" /> : <DoneIcon className="size-4 shrink-0 text-hint" />}
        <span className={cn("min-w-0 truncate", running && "shimmer-text")}>
          {running ? `${part.title}…` : pastTense(part.title)}
          {part.summary && <span className="text-hint"> · {part.summary}</span>}
        </span>
        {expandable && <ChevronDownIcon className={cn("ml-auto size-3.5 shrink-0 text-hint opacity-0 transition group-hover:opacity-100", open && "rotate-180 opacity-100")} />}
      </button>
      {open && part.input !== undefined && <ToolCode name={part.name} code={JSON.stringify(part.input, null, 2)} className="mt-1 mb-2 ml-6" />}
      {part.output && (running || open) && (
        <ToolCode name="Output" code={part.output.length > 4000 ? `…${part.output.slice(-4000)}` : part.output} className="mt-1 mb-2 ml-6" bodyClassName="max-h-40" testId="agent-tool-output" />
      )}
    </li>
  );
}

/** Nebius Echo's tool block: a titled code card ("Tool: run_command") with a copy button. */
function ToolCode({ name, code, className, bodyClassName, testId }: { name: string; code: string; className?: string; bodyClassName?: string; testId?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-code-well", className)} data-testid={testId}>
      <div className="flex h-8 items-center justify-between gap-2 bg-generic pr-2 pl-3">
        <span className="truncate font-mono text-code">{name === "Output" ? name : `Tool: ${name}`}</span>
        <CopyButton text={code} label="Copy" />
      </div>
      <pre className={cn("max-h-48 overflow-auto px-3 py-2.5 font-mono text-code break-all whitespace-pre-wrap text-complementary", bodyClassName)}>{code}</pre>
    </div>
  );
}

/** Nebius's filled warning alert: icon, a title and what's being asked. */
function ApprovalAlert({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-warning-tint px-4 py-3.5">
      <WarningIcon className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0">
        <h4 className="text-chat font-semibold">{title}</h4>
        <div className="mt-0.5 text-complementary">{children}</div>
      </div>
    </div>
  );
}

function Decided({ state, approved = "Approved", children }: { state: "approved" | "rejected" | "expired" | "pending"; approved?: string; children?: ReactNode }) {
  return (
    <div className="flex h-6 items-center gap-1.5 text-hint">
      {state === "approved" ? <DoneIcon className="size-4 text-positive" /> : state === "rejected" ? <CloseIcon className="size-4" /> : <InfoIcon className="size-4" />}
      {state === "approved" ? approved : state === "rejected" ? "Rejected" : "Expired"}
      {children}
    </div>
  );
}

function DecideButtons({ onReject, approve, busy }: { onReject: () => void; approve: ReactNode; busy?: boolean }) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="outline" size="sm" className="border-danger/50 text-danger hover:bg-danger-tint" onClick={onReject} disabled={busy}>
        <CloseIcon /> Reject
      </Button>
      {approve}
    </div>
  );
}

const approveClass = "border-positive/50 text-positive hover:bg-positive-tint";

/** Consequential steps wait here; nothing runs until the expert approves. */
function ApprovalCard({ part, projectId, onDecide }: { part: Extract<MessagePart, { type: "approval" }>; projectId: string; onDecide: (d: "approve" | "reject") => void }) {
  const pending = part.state === "pending";
  // A proposal (propose_schema / propose_relationship) is confirmed by a person in Explore.
  const proposal = part.detail?.kind === "proposal" ? part.detail : undefined;
  // todo16 D8: a catalogue operation that asks first: what goes, and whether it can be undone.
  const operation = part.detail?.kind === "operation" ? part.detail : undefined;
  return (
    <section className="flex flex-col gap-4" data-testid="agent-approval">
      {!operation && <ToolCode name={part.toolName} code={part.inputPreview} />}
      {pending ? (
        <>
          <ApprovalAlert title={operation ? (operation.irreversible ? "Delete forever?" : "Move to Trash?") : "Approval required"}>
            {part.summary}
            {operation && (
              <span className="mt-1 block text-hint" data-testid="agent-operation-impact">
                {operation.impact.files !== undefined && `${operation.impact.files.toLocaleString()} file${operation.impact.files === 1 ? "" : "s"}. `}
                {operation.impact.items.length > 0 && `${operation.impact.items.length} item${operation.impact.items.length === 1 ? "" : "s"}. `}
                {operation.irreversible ? "This can't be undone." : "You can restore it from the Trash for 30 days."}
              </span>
            )}
          </ApprovalAlert>
          <DecideButtons
            onReject={() => onDecide("reject")}
            approve={
              <Button variant="outline" size="sm" className={approveClass} onClick={() => onDecide("approve")}>
                <DoneIcon /> Approve
              </Button>
            }
          />
        </>
      ) : (
        <Decided state={part.state}>
          {proposal && part.state === "approved" && (
            <Link to={exploreUrl(projectId, proposal.proposalKind === "mapping" ? "mappings" : "relationships")} className="ml-auto text-brand underline-offset-2 hover:underline" data-testid="agent-proposal-link">
              Review in Explore
            </Link>
          )}
        </Decided>
      )}
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
  const detail = part.detail as Extract<ApprovalDetail, { kind: "plugin-install" }>;
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
    <section className="flex flex-col gap-4" data-testid="agent-install-approval">
      {pending ? (
        <>
          <ApprovalAlert title="Review a plugin install">
            The agent wants to install a plugin in this workspace. Review what it adds before approving.
            {error && <p className="mt-1 text-danger" role="alert">{error}</p>}
          </ApprovalAlert>
          <DecideButtons
            onReject={() => void finish("reject")}
            busy={busy}
            approve={
              <Button variant="outline" size="sm" className={approveClass} onClick={() => void open()} disabled={busy} data-testid="open-install-review">
                Review install
              </Button>
            }
          />
        </>
      ) : (
        <Decided state={part.state} approved="Installed" />
      )}
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

/** An environment edit the agent applied: one Studio undo step, marked as AI-made. */
function ChangeCard({ part, onUndo }: { part: Extract<MessagePart, { type: "change" }>; onUndo?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-prov-ai/10 px-3 py-2.5" data-testid="agent-change">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-prov-ai" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={part.undone ? "text-muted-foreground line-through" : "font-semibold"}>Agent changed: {part.summary}</div>
        {part.keys.length > 0 && <div className="text-muted-foreground">{part.keys.join(", ")}</div>}
      </div>
      {!part.undone && onUndo && (
        <Button variant="ghost-secondary" size="sm" className="-my-0.5 shrink-0" onClick={onUndo}>
          <UndoIcon /> Undo
        </Button>
      )}
    </div>
  );
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex h-7 items-center gap-1.5 text-muted-foreground hover:text-foreground" aria-expanded={open}>
        <span className={cn(live && "shimmer-text")}>{live ? "Thinking…" : "Thought process"}</span>
        <ChevronDownIcon className={cn("size-3.5 transition", open && "rotate-180")} />
      </button>
      {open && <Markdown text={text} className="mt-1 border-l-2 border-border pl-3 text-muted-foreground" />}
    </div>
  );
}
