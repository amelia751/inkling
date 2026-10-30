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
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const firstText = (r: any): string =>
  Array.isArray(r?.content) ? r.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("") : typeof r === "string" ? r : "";

const SECRET_KEY_RE = /(key|token|secret|password|authorization)/i;

/** Tool inputs are shown to the user; drop anything that looks like a credential and clip long strings. */
export function redactInput(input: unknown): unknown {
  if (Array.isArray(input)) return input.slice(0, 50).map(redactInput);
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redactInput(v);
    return out;
  }
  return typeof input === "string" ? clip(input, 2000) : input;
}

export function toolTitle(name: string, args: any): string {
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
      return name.replace(/_/g, " ");
  }
}

/** Stateful projection of one run's pi events onto the Inkling panel contract. */
export class Projector {
  private readonly args = new Map<string, unknown>();
  private readonly progress = new Map<string, number>();
  spendUsd = 0;

  constructor(private readonly model: string) {}

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
        return [{ type: "tool-call", id: e.toolCallId, name: e.toolName, title: toolTitle(e.toolName, e.args) }];
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
        const card = e.result?.details?.card;
        return [{ type: "tool-result", id: e.toolCallId, ok: !e.isError, summary: clip(firstText(e.result), 500), input, ...(card ? { card } : {}) }];
      }
      case "message_end": {
        const m = e.message as any;
        if (m?.role !== "assistant") return [];
        const out: AgentEventBody[] = [];
        const u = m.usage;
        if (u) {
          const cost = Number(u.cost?.total ?? 0);
          this.spendUsd += cost;
          const input = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          out.push({ type: "usage", inputTokens: input, outputTokens: u.output ?? 0, costUsd: cost });
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

/** Strip anything key-shaped before an error reaches the browser. */
export function sanitizeError(msg: string): string {
  return clip(msg.replace(/\b(sk|dtn|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]"), 1000);
}
