import type { ThreadMessage, ThreadPart } from "@studio/agent-protocol";
import type { RunRecord, UiPartRecord } from "../store/types.ts";

/**
 * todo20 W3 / D2: a conversation's visible thread, rebuilt on the server from the stored pi
 * transcript plus the session's run records, in the shape the web drawer renders
 * (`ChatMessage` in apps/web/src/studio/stores/agent.ts). Parts that aren't in the transcript
 * (cards, boots, environment changes the browser added; approvals the service asked for) are
 * recorded as ui parts (todo22 W4) and put back in place here.
 */

const TITLE_MAX = 60;

/** The user's own words in a stored user message: no `<studio_context>` block, no `<drop>` block. */
export function parseUserText(raw: string): { text: string; dropId?: string } {
  let s = raw.replace(/^<studio_context>[\s\S]*?<\/studio_context>\s*/, "");
  let dropId: string | undefined;
  s = s.replace(/<drop id="([^"]+)"(?:[^>]*\/>|>[\s\S]*?<\/drop>)\s*/g, (_m, id: string) => {
    dropId ??= id;
    return "";
  });
  return { text: s.trim(), ...(dropId ? { dropId } : {}) };
}

/** A chat title from the first user message: one line, at most ~60 characters. */
export function titleFrom(text: string): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length <= TITLE_MAX ? line : `${line.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

type Content = string | { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }[];
interface Entry {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: { role?: string; content?: Content; timestamp?: number; model?: string; provider?: string; toolCallId?: string; isError?: boolean; details?: { summary?: unknown }; stopReason?: string; errorMessage?: string };
}

const textOf = (c: Content | undefined): string =>
  typeof c === "string" ? c : (c ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");

/** Title from a transcript (header first): the first user message's own words. */
export function titleFromTranscript(entries: unknown[]): string | null {
  for (const e of entries as Entry[]) {
    if (e?.type === "message" && e.message?.role === "user") {
      const t = titleFrom(parseUserText(textOf(e.message.content)).text);
      if (t) return t;
    }
  }
  return null;
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim().slice(0, 200);

/**
 * `entries`: the transcript, header first. `runs`: the session's run records (any order); each
 * assistant message gets the run that was started last at or before its user message.
 */
export function buildThread(entries: unknown[], runs: RunRecord[], titles: ReadonlyMap<string, string> = new Map(), uiParts: UiPartRecord[] = [], now = Date.now()): ThreadMessage[] {
  const sorted = [...runs].sort((a, b) => a.createdAt - b.createdAt);
  const out: ThreadMessage[] = [];
  let assistant: ThreadMessage | undefined;
  const runFor = (at: number) => {
    let found: RunRecord | undefined;
    // 2 s slack: the run record is written just after the message is accepted.
    for (const r of sorted) if (r.createdAt <= at + 2000) found = r;
    return found;
  };
  for (const e of entries as Entry[]) {
    if (e?.type !== "message" || !e.message) continue;
    const m = e.message;
    const at = Number(m.timestamp) || Date.parse(e.timestamp ?? "") || 0;
    if (m.role === "user") {
      const { text, dropId } = parseUserText(textOf(m.content));
      const parts: ThreadPart[] = [...(dropId ? [{ type: "drop" as const, id: dropId }] : []), ...(text ? [{ type: "text" as const, text }] : [])];
      out.push({ id: e.id ?? `u${out.length}`, role: "user", parts });
      const run = runFor(at);
      assistant = { id: `${e.id ?? out.length}-a`, role: "assistant", parts: [] };
      if (run) {
        assistant.runId = run.id;
        assistant.runStatus = run.status === "interrupted" ? "failed" : run.status;
        if (run.status === "cancelled") assistant.stopped = true;
        if (run.status === "interrupted") assistant.error = "The run was interrupted. Send “continue” to pick up where it left off.";
        if (run.usage) assistant.usage = { ...run.usage };
      }
      out.push(assistant);
      continue;
    }
    if (m.role !== "assistant" && m.role !== "toolResult") continue;
    if (!assistant) {
      assistant = { id: `${e.id ?? out.length}-a`, role: "assistant", parts: [] };
      out.push(assistant);
    }
    const parts = assistant.parts;
    if (m.role === "assistant") {
      if (m.provider && m.model) assistant.model = `${m.provider}:${m.model}`;
      for (const c of typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? [])) {
        const last = parts[parts.length - 1];
        if (c.type === "text" && c.text) {
          if (last?.type === "text") last.text += c.text;
          else parts.push({ type: "text", text: c.text });
        } else if (c.type === "thinking" && c.thinking) {
          if (last?.type === "reasoning") last.text += c.thinking;
          else parts.push({ type: "reasoning", text: c.thinking });
        } else if (c.type === "toolCall" && c.id && c.name) {
          parts.push({ type: "tool", id: c.id, name: c.name, title: titles.get(c.name) ?? c.name, status: "running", input: c.arguments });
        }
      }
      if (m.stopReason === "error" && m.errorMessage) assistant.error = m.errorMessage;
    } else if (m.role === "toolResult" && m.toolCallId) {
      const p = parts.find((x) => x.type === "tool" && x.id === m.toolCallId);
      if (p?.type === "tool") {
        p.status = m.isError ? "error" : "done";
        const own = m.details?.summary;
        const summary = typeof own === "string" ? own : firstLine(textOf(m.content));
        if (summary) p.summary = summary;
      }
    }
  }
  // A tool still "running" in a finished run never got its result (cancelled, crashed).
  for (const msg of out)
    if (msg.role === "assistant" && msg.runStatus && !["queued", "running", "awaiting_approval"].includes(msg.runStatus))
      for (const p of msg.parts) if (p.type === "tool" && p.status === "running") p.status = "error";
  placeUiParts(out, uiParts, sorted, now);
  return out;
}

/**
 * todo22 W4: put recorded parts back in their message: the assistant message of their run, else the
 * message with their id. A part already there (same type and id) is replaced. An approval is live
 * (`pending`) only while its run still waits for approval and it hasn't expired; a replayed one is
 * otherwise `used` (approvals are single-use: the service accepts one answer, once).
 */
export function placeUiParts(messages: ThreadMessage[], uiParts: UiPartRecord[], runs: RunRecord[], now = Date.now()): void {
  const byRun = new Map<string, ThreadMessage>();
  for (const m of messages) if (m.role === "assistant" && m.runId) byRun.set(m.runId, m);
  for (const rec of uiParts) {
    const msg = (rec.runId ? byRun.get(rec.runId) : undefined) ?? messages.find((m) => m.id === rec.messageId);
    if (!msg) continue;
    let part = { ...rec.part } as ThreadPart;
    if (part.type === "approval") {
      const run = runs.find((r) => r.id === rec.runId);
      const live = part.state === "pending" && run?.status === "awaiting_approval" && part.expiresAt > now;
      if (!live) part = { ...part, state: part.state === "pending" ? "expired" : part.state, used: true };
    }
    const i = msg.parts.findIndex((p) => p.type === part.type && "id" in p && p.id === (part as { id: string }).id);
    if (i >= 0) {
      msg.parts[i] = part;
      continue;
    }
    // Right after the tool call that made it (a card or change shares the call's id), else at the end.
    const toolId = part.type === "approval" ? part.toolCallId : (part as { id?: string }).id;
    let at = msg.parts.findIndex((p) => p.type === "tool" && p.id === toolId);
    if (at < 0) {
      msg.parts.push(part);
      continue;
    }
    while (msg.parts[at + 1] && msg.parts[at + 1]!.type !== "text" && msg.parts[at + 1]!.type !== "tool" && msg.parts[at + 1]!.type !== "reasoning") at++;
    msg.parts.splice(at + 1, 0, part);
  }
}

/**
 * todo21 W4: how many transcript rows (header at 0) hold thread messages `0..messageIdx` of
 * `buildThread(entries)`. A user message keeps itself; an assistant message (or a tool result in
 * it) keeps its whole turn, up to the next user message. Undefined when there's no such message.
 */
export function transcriptCut(entries: unknown[], messageIdx: number): number | undefined {
  if (!Number.isInteger(messageIdx) || messageIdx < 0) return undefined;
  // Mirrors buildThread's message boundaries: each user entry opens a user and an assistant message.
  let count = 0;
  let open = false;
  for (let p = 0; p < entries.length; p++) {
    const e = (entries as Entry[])[p];
    if (e?.type !== "message" || !e.message) continue;
    const role = e.message.role;
    if (role === "user") {
      if (open && count - 1 === messageIdx) return p; // the kept assistant turn ends here
      if (count === messageIdx) return p + 1;
      count += 2;
      open = true;
    } else if (role === "assistant" || role === "toolResult") {
      if (!open) {
        count += 1;
        open = true;
      }
    }
  }
  return open && count - 1 === messageIdx ? entries.length : undefined;
}
