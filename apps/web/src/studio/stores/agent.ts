import { create } from "zustand";
import { RES } from "@studio/contracts/naming";
import { persist } from "zustand/middleware";
import { CARD_TOOL_NAMES } from "@/studio/lib/agent/card-tools";
import { AgentHttpError, answerClientTool, cancelRun, createSession, decideApproval, deleteSession, followRun, sendMessage } from "@/studio/lib/agent/client";
import { kernelToken } from "@/studio/lib/agent/kernel-token";
import type { AgentCard, DatasetSnapshot as AgentContext, AgentEvent, ApprovalDetail, ClientToolSpec, ProfileName, RunStatus, SandboxState } from "@studio/agent-protocol";

/** `undone`: an applied card whose change was reverted from the card (reorganization plans). */
export type CardState = "open" | "applied" | "dismissed" | "undone";
export type ApprovalState = "pending" | "approved" | "rejected" | "expired";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; title: string; status: "running" | "done" | "error"; summary?: string; input?: unknown; output?: string }
  | { type: "card"; id: string; card: AgentCard; state: CardState }
  | { type: "approval"; id: string; toolName: string; summary: string; inputPreview: string; state: ApprovalState; expiresAt: number; detail?: ApprovalDetail }
  | { type: "change"; id: string; summary: string; keys: string[]; undone?: boolean }
  | { type: "artifact"; id: string; name: string; bytes: number }
  | { type: "status"; text: string }
  /** A Studio boot (todo11): the card reads its progress from the boots store (project `boot.*` events). */
  | { type: "boot"; id: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  /** Assistant only. */
  model?: string;
  /** The run this message streams (from `start`): a boot it started names it as `initiator.runId`. */
  runId?: string;
  /** The service's run status (`run-status`): queued, running, awaiting approval… */
  runStatus?: RunStatus;
  error?: string;
  stopped?: boolean;
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number };
  sandbox?: SandboxState;
}

/** What running a client tool in the browser produced. */
export interface ClientToolOutcome {
  ok: boolean;
  output: unknown;
  summary?: string;
  card?: AgentCard;
  /** An environment edit the expert can undo from the thread. */
  change?: { summary: string; keys: string[] };
}

/** Supplied by the open assistant (Studio panel or project drawer): runs client tools in the browser. */
export interface AgentHost {
  projectId: string;
  runTool(name: string, input: Record<string, unknown>): Promise<ClientToolOutcome>;
}

export interface SendOptions {
  profile: ProfileName;
  clientTools: ClientToolSpec[];
  catalogPrompt?: string;
  restricted: boolean;
  /** The Studio's dataset snapshot; other sections have none (the project tools look things up). */
  snapshot?: AgentContext;
  context: string;
}

interface ActiveRun {
  projectId: string;
  runId: string;
  /** Assistant message the run's events go to. */
  messageId: string;
  lastSeq: number;
  /** Client-tool calls already executed, so a replay after reload never runs one twice. */
  answered: string[];
}

interface AgentState {
  /** Conversations per dataset. */
  threads: Record<string, ChatMessage[]>;
  /** Service session per dataset (the service keeps the model transcript). */
  sessions: Record<string, { sessionId: string; profile: ProfileName }>;
  /** Notes for the model's next turn, e.g. that the expert undid a change. */
  notes: Record<string, string[]>;
  /** The run being followed; persisted so a reload reattaches with `after=lastSeq`. */
  active: ActiveRun | null;
  /** The expert agreed to share this dataset's text context with the model provider. */
  consent: boolean;
  profile: ProfileName;
  /** Dataset whose run is streaming in this tab, if any. */
  running: string | null;
  setConsent: (v: boolean) => void;
  setProfile: (p: ProfileName) => void;
  setHost: (host: AgentHost | null) => void;
  send: (projectId: string, text: string, opts: SendOptions) => Promise<void>;
  reattach: (projectId: string) => void;
  stop: () => void;
  reset: (projectId: string) => void;
  addNote: (projectId: string, note: string) => void;
  setCardState: (projectId: string, messageId: string, cardId: string, state: CardState) => void;
  setPart: (projectId: string, messageId: string, partId: string, patch: Partial<MessagePart>) => void;
  decide: (projectId: string, messageId: string, approvalId: string, decision: "approve" | "reject") => Promise<void>;
  /** Append a part to a message (a boot card under the offer that started it). */
  addPart: (projectId: string, messageId: string, part: MessagePart) => void;
  /** A boot the run streaming in this tab started: its card goes under that run's message. Returns whether it matched. */
  attachBoot: (runId: string, bootId: string) => boolean;
  /** A turn answered in the browser without the model (`/studio <words>`): the user's text and the reply's parts. */
  addLocal: (projectId: string, text: string, parts: MessagePart[]) => string;
}

let host: AgentHost | null = null;
let controller: AbortController | null = null;
/**
 * Runs this tab streamed (not persisted: another tab never claims them). A boot whose
 * `initiator.runId` is one of these was asked for here, even when the run already finished
 * by the time `boot.started` arrives on the project stream.
 */
const streamed = new Map<string, { projectId: string; messageId: string }>();

const plainSummary = (output: unknown): string | undefined => {
  if (!output || typeof output !== "object") return undefined;
  const o = output as { error?: unknown; errors?: unknown[] };
  if (o.error) return String(o.error).slice(0, 120);
  if (Array.isArray(o.errors)) return `${o.errors.length} error${o.errors.length === 1 ? "" : "s"}`;
  return undefined;
};

function reduce(m: ChatMessage, e: AgentEvent): ChatMessage {
  const parts = [...m.parts];
  const last = parts[parts.length - 1];
  const at = (pred: (p: MessagePart) => boolean) => parts.findIndex(pred);
  switch (e.type) {
    case "start":
      return { ...m, model: e.model, runId: e.runId };
    case "run-status":
      return { ...m, runStatus: e.status };
    case "text":
      if (last?.type === "text") parts[parts.length - 1] = { ...last, text: last.text + e.delta };
      else parts.push({ type: "text", text: e.delta });
      return { ...m, parts };
    case "reasoning":
      if (last?.type === "reasoning") parts[parts.length - 1] = { ...last, text: last.text + e.delta };
      else parts.push({ type: "reasoning", text: e.delta });
      return { ...m, parts };
    case "tool-call":
      if (at((p) => p.type === "tool" && p.id === e.id) < 0) parts.push({ type: "tool", id: e.id, name: e.name, title: e.title, status: "running" });
      return { ...m, parts };
    case "tool-progress": {
      const i = at((p) => p.type === "tool" && p.id === e.id);
      if (i >= 0) parts[i] = { ...(parts[i] as Extract<MessagePart, { type: "tool" }>), output: e.text };
      return { ...m, parts };
    }
    case "tool-result": {
      const i = at((p) => p.type === "tool" && p.id === e.id);
      if (i >= 0) {
        const p = parts[i] as Extract<MessagePart, { type: "tool" }>;
        // A summary the browser already set (card and environment tools) is more specific than the service's.
        parts[i] = { ...p, status: e.ok ? "done" : "error", summary: p.summary ?? e.summary, input: e.input };
      }
      return { ...m, parts };
    }
    case "approval":
      parts.push({ type: "approval", id: e.approvalId, toolName: e.toolName, summary: e.summary, inputPreview: e.inputPreview, state: "pending", expiresAt: e.expiresAt, detail: e.detail });
      return { ...m, parts };
    case "approval-resolved": {
      const i = at((p) => p.type === "approval" && p.id === e.approvalId);
      if (i >= 0) {
        const p = parts[i] as Extract<MessagePart, { type: "approval" }>;
        const state: ApprovalState = e.decision === "approve" ? "approved" : p.state === "pending" && p.expiresAt < Date.now() ? "expired" : "rejected";
        parts[i] = { ...p, state };
      }
      return { ...m, parts };
    }
    case "sandbox":
      return { ...m, sandbox: e.state };
    case "artifact":
      parts.push({ type: "artifact", id: e.id, name: e.name, bytes: e.bytes });
      return { ...m, parts };
    case "status":
      parts.push({ type: "status", text: e.text });
      return { ...m, parts };
    case "usage": {
      const u = m.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 };
      return {
        ...m,
        usage: {
          inputTokens: u.inputTokens + e.inputTokens,
          outputTokens: u.outputTokens + e.outputTokens,
          cachedTokens: u.cachedTokens + e.cachedTokens,
          costUsd: u.costUsd + e.costUsd,
        },
      };
    }
    case "error":
      return { ...m, error: e.message };
    case "done":
      return e.status === "cancelled" ? { ...m, stopped: true, runStatus: e.status } : { ...m, runStatus: e.status };
    default:
      return m;
  }
}

export const useAgent = create<AgentState>()(
  persist(
    (set, get) => {
      const patchMessage = (projectId: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) =>
        set((s) => ({ threads: { ...s.threads, [projectId]: (s.threads[projectId] ?? []).map((m) => (m.id === messageId ? fn(m) : m)) } }));

      /** Run a client tool the service asked for, then post its result (once per call id). */
      async function clientTool(a: ActiveRun, e: Extract<AgentEvent, { type: "client-tool" }>) {
        if (a.answered.includes(e.callId)) return;
        a.answered.push(e.callId);
        set({ active: { ...a } });
        let outcome: ClientToolOutcome;
        if (!host || host.projectId !== a.projectId) outcome = { ok: false, output: { error: "The assistant for this project is closed." } };
        else {
          try {
            outcome = await host.runTool(e.name, (e.input ?? {}) as Record<string, unknown>);
          } catch (err) {
            outcome = { ok: false, output: { error: err instanceof Error ? err.message : String(err) } };
          }
        }
        patchMessage(a.projectId, a.messageId, (m) => {
          const parts = [...m.parts];
          const i = parts.findIndex((p) => p.type === "tool" && p.id === e.callId);
          const summary = outcome.summary ?? plainSummary(outcome.output);
          if (i >= 0 && summary) parts[i] = { ...(parts[i] as Extract<MessagePart, { type: "tool" }>), summary };
          if (outcome.card) parts.push({ type: "card", id: e.callId, card: outcome.card, state: "open" });
          if (outcome.change) parts.push({ type: "change", id: e.callId, ...outcome.change });
          return { ...m, parts };
        });
        // Card tools were already answered by the service; everything else waits for this post.
        if (!CARD_TOOL_NAMES.has(e.name)) {
          await answerClientTool(a.runId, e.callId, { ok: outcome.ok, output: outcome.output }).catch(() => {
            // 409: timed out or cancelled meanwhile; the service already told the model.
          });
        }
      }

      async function follow(a: ActiveRun) {
        controller?.abort();
        const ctl = new AbortController();
        controller = ctl;
        streamed.set(a.runId, { projectId: a.projectId, messageId: a.messageId });
        set({ running: a.projectId, active: a });
        try {
          await followRun(
            a.runId,
            a.lastSeq,
            async (e) => {
              const cur = get().active;
              if (!cur || cur.runId !== a.runId) return;
              patchMessage(cur.projectId, cur.messageId, (m) => reduce(m, e));
              if (e.type === "client-tool") void clientTool(cur, e);
              set({ active: { ...cur, lastSeq: e.seq } });
            },
            ctl.signal,
          );
        } catch (err) {
          if (!ctl.signal.aborted) {
            const message = err instanceof Error ? err.message : String(err);
            patchMessage(a.projectId, a.messageId, (m) => ({ ...m, error: m.error ?? message }));
          }
        } finally {
          if (controller === ctl) {
            controller = null;
            // Tools still marked running when a run ends were cut off.
            patchMessage(a.projectId, a.messageId, (m) => ({
              ...m,
              parts: m.parts.map((p) =>
                p.type === "tool" && p.status === "running" ? { ...p, status: "error" as const, summary: p.summary ?? "Stopped" } : p.type === "approval" && p.state === "pending" ? { ...p, state: "expired" as const } : p,
              ),
            }));
            set((s) => ({ running: null, active: s.active?.runId === a.runId ? null : s.active }));
          }
        }
      }

      async function ensureSession(projectId: string, opts: SendOptions, fresh = false) {
        const cur = get().sessions[projectId];
        if (cur && cur.profile === opts.profile && !fresh) return cur.sessionId;
        if (cur) void deleteSession(cur.sessionId).catch(() => {});
        const res = await createSession({
          projectId,
          profile: opts.profile,
          clientTools: opts.clientTools,
          catalogPrompt: opts.catalogPrompt,
          restricted: opts.restricted,
          kernelToken: await kernelToken(projectId, opts.profile),
        });
        set((s) => ({ sessions: { ...s.sessions, [projectId]: { sessionId: res.sessionId, profile: res.profile } } }));
        return res.sessionId;
      }

      return {
        threads: {},
        sessions: {},
        notes: {},
        active: null,
        consent: false,
        profile: "environment-designer",
        running: null,
        setConsent: (consent) => set({ consent }),
        setProfile: (profile) => set({ profile }),
        setHost: (h) => {
          host = h;
        },
        send: async (projectId, text, opts) => {
          const state = get();
          if (state.running && state.running !== projectId) return;
          const steering = state.running === projectId && state.active;
          const user: ChatMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
          const assistant: ChatMessage = { id: crypto.randomUUID(), role: "assistant", parts: [] };
          set((s) => ({ threads: { ...s.threads, [projectId]: [...(s.threads[projectId] ?? []), user, assistant] } }));
          const notes = get().notes[projectId] ?? [];
          const context = [opts.context, ...notes].join("\n");
          try {
            let sessionId = await ensureSession(projectId, opts);
            const req = { text, context, snapshot: opts.snapshot, kernelToken: await kernelToken(projectId, opts.profile) };
            const res = await sendMessage(sessionId, req).catch(async (err) => {
              // The service restarted without this session: start a fresh one (history stays on screen).
              if (!(err instanceof AgentHttpError) || err.status !== 404) throw err;
              sessionId = await ensureSession(projectId, opts, true);
              return sendMessage(sessionId, req);
            });
            set((s) => ({ notes: { ...s.notes, [projectId]: [] } }));
            if (steering && res.steered && get().active?.runId === res.runId) {
              // Same run: route the rest of its events to the new assistant message.
              streamed.set(res.runId, { projectId, messageId: assistant.id });
              set((s) => ({ active: s.active ? { ...s.active, messageId: assistant.id } : s.active }));
              return;
            }
            await follow({ projectId, runId: res.runId, messageId: assistant.id, lastSeq: 0, answered: [] });
          } catch (e) {
            patchMessage(projectId, assistant.id, (m) => ({ ...m, error: e instanceof Error ? e.message : String(e) }));
            set({ running: null });
          }
        },
        reattach: (projectId) => {
          const a = get().active;
          if (!a || a.projectId !== projectId || controller) return;
          void follow(a);
        },
        stop: () => {
          const a = get().active;
          if (!a) return controller?.abort();
          // Cancel on the service; the stream then ends with `done: cancelled`. Fall back to local abort.
          cancelRun(a.runId).catch(() => controller?.abort());
          setTimeout(() => {
            if (get().active?.runId === a.runId) controller?.abort();
          }, 5000);
        },
        reset: (projectId) => {
          if (get().running === projectId) get().stop();
          const session = get().sessions[projectId];
          if (session) void deleteSession(session.sessionId).catch(() => {});
          set((s) => {
            const sessions = { ...s.sessions };
            delete sessions[projectId];
            return { sessions, threads: { ...s.threads, [projectId]: [] }, notes: { ...s.notes, [projectId]: [] } };
          });
        },
        addNote: (projectId, note) => set((s) => ({ notes: { ...s.notes, [projectId]: [...(s.notes[projectId] ?? []), note] } })),
        setCardState: (projectId, messageId, cardId, state) =>
          patchMessage(projectId, messageId, (m) => ({ ...m, parts: m.parts.map((p) => (p.type === "card" && p.id === cardId ? { ...p, state } : p)) })),
        setPart: (projectId, messageId, partId, patch) =>
          patchMessage(projectId, messageId, (m) => ({
            ...m,
            parts: m.parts.map((p) => ("id" in p && p.id === partId ? ({ ...p, ...patch } as MessagePart) : p)),
          })),
        decide: async (projectId, messageId, approvalId, decision) => {
          const setState = (state: ApprovalState) =>
            patchMessage(projectId, messageId, (m) => ({ ...m, parts: m.parts.map((p) => (p.type === "approval" && p.id === approvalId ? { ...p, state } : p)) }));
          setState(decision === "approve" ? "approved" : "rejected");
          await decideApproval(approvalId, { decision }).catch(() => setState("expired"));
        },
        addPart: (projectId, messageId, part) =>
          patchMessage(projectId, messageId, (m) => (m.parts.some((p) => "id" in p && p.id === (part as { id?: string }).id && p.type === part.type) ? m : { ...m, parts: [...m.parts, part] })),
        attachBoot: (runId, bootId) => {
          const a = get().active;
          const r = a?.runId === runId ? a : streamed.get(runId);
          if (!r) return false;
          get().addPart(r.projectId, r.messageId, { type: "boot", id: bootId });
          return true;
        },
        addLocal: (projectId, text, parts) => {
          const user: ChatMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
          const reply: ChatMessage = { id: crypto.randomUUID(), role: "assistant", parts };
          set((s) => ({ threads: { ...s.threads, [projectId]: [...(s.threads[projectId] ?? []), user, reply] } }));
          return reply.id;
        },
      };
    },
    {
      name: `${RES}-ai`,
      version: 2,
      // v1 threads were for the old stateless loop; their shape is compatible, sessions start fresh.
      migrate: (persisted) => ({ ...(persisted as object), sessions: {}, notes: {}, active: null }) as never,
      partialize: (s) => ({ consent: s.consent, threads: s.threads, sessions: s.sessions, notes: s.notes, active: s.active, profile: s.profile }),
    },
  ),
);
