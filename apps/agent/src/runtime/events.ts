import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, AgentEventBody } from "../protocol.ts";

const RING = 2000;

/** Per-run event feed: monotonic seq, bounded replay buffer, live subscribers. */
export class EventLog {
  private readonly buf: AgentEvent[] = [];
  private readonly subs = new Set<(e: AgentEvent) => void>();
  private seq = 0;
  closed = false;

  constructor(readonly runId: string) {}

  push(body: AgentEventBody): AgentEvent {
    const e = { ...body, seq: ++this.seq, runId: this.runId, at: Date.now() } as AgentEvent;
    this.buf.push(e);
    if (this.buf.length > RING) this.buf.shift();
    for (const s of this.subs) s(e);
    if (body.type === "done") this.closed = true;
    return e;
  }

  after(seq: number): AgentEvent[] {
    return this.buf.filter((e) => e.seq > seq);
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Oldest seq still in the replay buffer (lastSeq + 1 when empty). */
  get oldestSeq(): number {
    return this.buf[0]?.seq ?? this.seq + 1;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const firstText = (r: any): string =>
  Array.isArray(r?.content) ? r.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("") : typeof r === "string" ? r : "";

const SECRET_KEY_RE = /(key|token|secret|password|authorization|credential|cookie|^env$|^environment$|^envvars$)/i;

/**
 * Tool inputs are shown to the user. Commands are shown; environment variables and anything
 * credential-shaped are not (by key, and by value pattern inside strings). Long strings are clipped.
 */
export function redactInput(input: unknown): unknown {
  if (Array.isArray(input)) return input.slice(0, 50).map(redactInput);
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redactInput(v);
    return out;
  }
  return typeof input === "string" ? clip(scrubSecrets(input), 2000) : input;
}

export function toolTitle(name: string, args: any, label?: string): string {
  const s = (v: unknown) => (typeof v === "string" ? clip(v.split("\n")[0]!, 80) : "");
  switch (name) {
    case "bash":
      return `$ ${s(args?.command)}`;
    case "read":
    case "write":
    case "edit":
    case "ls":
      return `${name} ${s(args?.path) || "."}`;
    case "grep":
    case "find":
      return `${name} ${s(args?.pattern)}`;
    case "run_python":
      return `python: ${s(args?.code)}`;
    default:
      return label ?? name.replace(/_/g, " ");
  }
}

/** Stateful projection of one run's pi events onto the Studio panel contract. */
export class Projector {
  private readonly args = new Map<string, unknown>();
  private readonly progress = new Map<string, number>();
  spendUsd = 0;

  constructor(
    private readonly model: string,
    /** Tool name → row title (the tool's label); sandbox tools get a command-specific title. */
    private readonly titles: ReadonlyMap<string, string> = new Map(),
  ) {}

  project(e: AgentSessionEvent): AgentEventBody[] {
    switch (e.type) {
      case "agent_start":
        return [{ type: "start", model: this.model }];
      case "message_update": {
        const a = e.assistantMessageEvent;
        if (a.type === "text_delta") return [{ type: "text", delta: a.delta }];
        if (a.type === "thinking_delta") return [{ type: "reasoning", delta: a.delta }];
        return [];
      }
      case "tool_execution_start":
        this.args.set(e.toolCallId, e.args);
        return [{ type: "tool-call", id: e.toolCallId, name: e.toolName, title: toolTitle(e.toolName, e.args, this.titles.get(e.toolName)) }];
      case "tool_execution_update": {
        const now = Date.now();
        if (now - (this.progress.get(e.toolCallId) ?? 0) < 250) return [];
        this.progress.set(e.toolCallId, now);
        const t = firstText(e.partialResult);
        return t ? [{ type: "tool-progress", id: e.toolCallId, text: t.length > 4000 ? `…${t.slice(-4000)}` : t }] : [];
      }
      case "tool_execution_end": {
        const input = redactInput(this.args.get(e.toolCallId));
        this.args.delete(e.toolCallId);
        this.progress.delete(e.toolCallId);
        return [{ type: "tool-result", id: e.toolCallId, ok: !e.isError, summary: summarize(e.result), input }];
      }
      case "message_end": {
        const m = e.message as any;
        if (m?.role !== "assistant") return [];
        const out: AgentEventBody[] = [];
        const u = m.usage;
        if (u) {
          const cost = Number(u.cost?.total ?? 0);
          this.spendUsd += cost;
          out.push({ type: "usage", inputTokens: u.input ?? 0, outputTokens: u.output ?? 0, cachedTokens: u.cacheRead ?? 0, costUsd: cost });
        }
        if (m.stopReason === "error" && m.errorMessage) out.push({ type: "error", message: sanitizeError(m.errorMessage) });
        return out;
      }
      case "compaction_start":
        return [{ type: "status", text: "Compacting the conversation…" }];
      case "compaction_end":
        return [{ type: "status", text: e.aborted ? "Compaction skipped" : "Conversation compacted" }];
      default:
        return [];
    }
  }
}

/** One line for the tool row: a tool's own `details.summary` if it set one, else its first line of text. */
function summarize(result: any): string {
  const own = result?.details?.summary;
  if (typeof own === "string") return clip(own, 200);
  const line = firstText(result).split("\n").find((l) => l.trim()) ?? "";
  return clip(sanitizeError(line), 200);
}

/** Replace key-shaped substrings (provider keys, bearer tokens, `*_KEY=…` assignments). */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=("[^"]*"|'[^']*'|\S+)/g, "$1=[redacted]")
    .replace(/\b(sk|dtn|pk|rk|ghp|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

/** Strip anything key-shaped before an error reaches the browser. */
export function sanitizeError(msg: string): string {
  return clip(scrubSecrets(msg), 1000);
}
