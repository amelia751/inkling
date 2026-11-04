import { create } from "zustand";
import { RES } from "@studio/contracts/naming";
import { followPerson, personStorage } from "@/studio/lib/person-key";
import { createJSONStorage, persist } from "zustand/middleware";
import { CARD_TOOL_NAMES } from "@/studio/lib/agent/card-tools";
import { AgentHttpError, answerClientTool, branchSession, cancelRun, createSession, decideApproval, deleteSession, fetchThread, followRun, listChats, postUiPart, renameSession, sendMessage, updateSession, type ChatSummary } from "@/studio/lib/agent/client";
import { fetchPrefs, putPref } from "@/studio/lib/prefs-api";
import { sessionTools } from "@/studio/lib/agent/session";
import { kernelToken } from "@/studio/lib/agent/kernel-token";
import { api } from "@/studio/lib/projects-api";
import type { CreateSessionResponse, RefreshTokenTool, AgentCard, DatasetSnapshot as AgentContext, AgentEvent, ApprovalDetail, ClientToolSpec, ProfileName, RunStatus, SandboxState } from "@studio/agent-protocol";
import { toolSummaryText } from "@studio/studio-tools/tool-summary";

/** `undone`: an applied card whose change was reverted from the card (reorganization plans). */
export type CardState = "open" | "applied" | "dismissed" | "undone";
export type ApprovalState = "pending" | "approved" | "rejected" | "expired";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; title: string; status: "running" | "done" | "error"; summary?: string; input?: unknown; output?: string }
  | { type: "card"; id: string; card: AgentCard; state: CardState }
  /** `used`: replayed from the server after it was decided or expired (todo22 W4); never live again. */
  | { type: "approval"; id: string; toolName: string; summary: string; inputPreview: string; state: ApprovalState; expiresAt: number; detail?: ApprovalDetail; toolCallId?: string; failed?: string; used?: boolean }
  | { type: "change"; id: string; summary: string; keys: string[]; undone?: boolean }
  | { type: "artifact"; id: string; name: string; bytes: number }
  | { type: "status"; text: string; id?: string }
  /** A Studio boot (todo11): the card reads its progress from the boots store (project `boot.*` events). */
  | { type: "boot"; id: string }
  /** todo13: files dropped with a user message; `id` is the drop's id (`core/drops` renders its card). */
  | { type: "drop"; id: string };

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
  /** todo18 D: the event stream dropped and is reconnecting (not persisted meaning: cleared on reconnect or end). */
  reconnecting?: boolean;
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
  /** todo13: a drop sent with (or as) this message. */
  drop?: { dropId: string };
  /** The user message's id, when the composer already gave it to the drop. */
  messageId?: string;
  /** Awaited before the service is asked (a drop's files registering with the kernel). */
  beforeSend?: () => Promise<void>;
}

export interface ActiveRun {
  projectId: string;
  /** The chat (session) whose thread the run's events go to, even after the person switches chats. */
  chatId: string;
  runId: string;
  /** Assistant message the run's events go to. */
  messageId: string;
  lastSeq: number;
  /** Client-tool calls already executed, so a replay after reload never runs one twice. */
  answered: string[];
}

export type { ChatSummary };

interface AgentState {
  /**
   * todo20 D2: a cache of each chat's thread, keyed by chat (= agent session) id; the server's
   * thread (`GET /v1/sessions/{id}/thread`) wins when it loads. A key that is a project id is a
   * thread from before chats (tests, old caches): `threadKey` falls back to it.
   */
  threads: Record<string, ChatMessage[]>;
  /** Service session per chat (normally the chat's own id; another when the profile changed or the chat was made offline). */
  sessions: Record<string, { sessionId: string; profile: ProfileName }>;
  /** Notes for the model's next turn, e.g. that the expert undid a change (per project). */
  notes: Record<string, string[]>;
  /** todo20 D2: the chat open per project. Its id names the `Shared in chat` folder's drops. */
  conversations: Record<string, { activeSessionId: string }>;
  /** todo20 D2: the project's chats, newest first (the server's list plus chats made here). */
  chats: Record<string, ChatSummary[]>;
  /** The project's active chat (made here when none is known yet; `ensureConversation` makes it on the server). */
  conversation: (projectId: string) => { id: string; title?: string };
  /** The project's active chat, created on the server on first use (a local `conv-…` id when the service is unreachable). */
  ensureConversation: (projectId: string, opts?: { restricted?: boolean }) => Promise<{ id: string; title?: string }>;
  /** Load the project's chats from the server and pick the newest when none is open. */
  loadChats: (projectId: string) => Promise<void>;
  /** Rebuild a chat's thread from the server (the cache stays when the service can't say). */
  loadThread: (chatId: string) => Promise<void>;
  /** Open another of the project's chats. */
  selectChat: (projectId: string, chatId: string) => void;
  /** Start another chat; the old one stays listed. */
  newChat: (projectId: string, opts?: { restricted?: boolean }) => Promise<void>;
  /** Alias of `newChat` (older callers). */
  reset: (projectId: string) => void;
  /** Delete a chat on the server; its shared files stay in Files (todo13 D15). */
  deleteChat: (projectId: string, chatId: string) => void;
  /** todo21 D3: hide a chat now and delete it after a few seconds; the returned function undoes it. */
  removeChat: (projectId: string, chatId: string, delayMs?: number) => () => void;
  /** todo21 D4: the person names a chat (`PATCH /v1/sessions/:id`); the service never replaces it. */
  renameChat: (projectId: string, chatId: string, title: string) => Promise<void>;
  /** todo21 D5: a new chat holding thread messages 0..messageIdx of `chatId`; it opens. */
  branchChat: (projectId: string, chatId: string, messageIdx: number) => Promise<string | null>;
  /** todo21: a `session.updated` summary from the service (auto title, rename, run start/finish). */
  applySession: (session: ChatSummary) => void;
  /** todo21 D6: runs per chat (two chats in a project run side by side); persisted so a reload reattaches with `after=lastSeq`. */
  runs: Record<string, ActiveRun>;
  /** Chats whose run this tab is streaming now. */
  streaming: Record<string, true>;
  /** todo21 D3: when each chat was last open here (ISO), for the rail's unread dot. */
  lastOpened: Record<string, string>;
  /** Chats whose run ended here while another chat was open. */
  unread: Record<string, true>;
  profile: ProfileName;
  /** todo18 D: the run another tab is following now (this tab stopped streaming it). */
  followedElsewhere?: string | null;
  takeOver: () => void;
  /** Legacy (todo18): sends are no longer refused across projects. */
  blockedBy?: { projectId: string; waitingOn: string } | null;
  setProfile: (p: ProfileName) => void;
  setHost: (host: AgentHost | null) => void;
  send: (projectId: string, text: string, opts: SendOptions) => Promise<void>;
  /** Follow again every run of the project's chats this tab isn't streaming. */
  reattach: (projectId: string) => void;
  /** Stop a chat's run (default: the project's open chat; no project: the open assistant's). */
  stop: (projectId?: string, chatId?: string) => void;
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

/** The cache key of the project's open thread: its active chat, or (legacy) the project id. */
export const threadKey = (s: Pick<AgentState, "conversations">, projectId: string): string => s.conversations[projectId]?.activeSessionId ?? projectId;
const NO_MESSAGES: ChatMessage[] = [];
/** A chat's thread (default: the project's open chat; a stable empty array when there is none). */
export const selectThread = (projectId: string, chatId?: string) => (s: AgentState) => s.threads[chatId ?? threadKey(s, projectId)] ?? NO_MESSAGES;
/** todo21 D6: a chat's run (default: the project's open chat), or null. */
export const selectRun = (projectId: string, chatId?: string) => (s: AgentState) => s.runs[chatId ?? threadKey(s, projectId)] ?? null;
/** Whether this tab streams a chat's run now (default: the project's open chat). */
export const selectStreaming = (projectId: string, chatId?: string) => (s: AgentState) => !!s.streaming[chatId ?? threadKey(s, projectId)];
/** The runs of a project's chats. */
export const projectRuns = (s: Pick<AgentState, "runs">, projectId: string) => Object.values(s.runs).filter((r) => r.projectId === projectId);
/** A chat's title: the server's, else "New chat" until the service names it (todo21 D4). */
export function chatTitle(_s: Pick<AgentState, "threads">, chat: Pick<ChatSummary, "id" | "title">): string {
  return chat.title || "New chat";
}

let host: AgentHost | null = null;
/** Event streams this tab follows, per chat. */
const controllers = new Map<string, AbortController>();
/** Browser-side tool work per chat's run: Stop aborts it and posts the failure at once. */
const toolAborts = new Map<string, { projectId: string; ctl: AbortController }>();
const abortTools = (pred: (chatId: string, projectId: string) => boolean) => {
  for (const [chatId, t] of toolAborts)
    if (pred(chatId, t.projectId)) {
      t.ctl.abort();
      toolAborts.delete(chatId);
    }
};
/** Chats hidden by `removeChat`, deleted on the server when their timer fires. */
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();
/** Chats being made on the server per project, so two callers share one. */
const creating = new Map<string, Promise<{ id: string; title?: string }>>();

/** todo18 D: one tab follows a run; the others say so and can take over. */
const TAB_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Math.random());
const followChannel: BroadcastChannel | null = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(`${RES}-agent-follow`) : null;
const handedOff = new Set<AbortController>();
/** The protocol package is types-only here (run-events.test); the type pins the literal. */
const REFRESH_TOKEN_TOOL: RefreshTokenTool = "__refresh_kernel_token";

export const STUDIO_CLOSED = "The Studio isn't open, so this tool can't run. Ask the person to open it, or use open_location.";
export const BLOCKED_PREFIX = "Waiting for the assistant in project ";
export const TOOL_STOPPED = "Stopped by the person.";

/** Run a browser tool, but give up as soon as `signal` aborts (Stop, panel closed). */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
  if (signal.aborted) return Promise.resolve(onAbort());
  return new Promise<T>((resolve, reject) => {
    const abort = () => resolve(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (v) => (signal.removeEventListener("abort", abort), resolve(v)),
      (e) => (signal.removeEventListener("abort", abort), reject(e)),
    );
  });
}
/**
 * Runs this tab streamed (not persisted: another tab never claims them). A boot whose
 * `initiator.runId` is one of these was asked for here, even when the run already finished
 * by the time `boot.started` arrives on the project stream.
 */
const streamed = new Map<string, { projectId: string; messageId: string; chatId: string }>();

const plainSummary = (output: unknown): string | undefined => {
  if (!output || typeof output !== "object") return undefined;
  const o = output as { error?: unknown; errors?: unknown[] };
  // todo24 W6: a sentence, never the error body.
  if (o.error || Array.isArray(o.errors)) return toolSummaryText(JSON.stringify(output));
  return undefined;
};

export function reduce(m: ChatMessage, e: AgentEvent): ChatMessage {
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
        parts[i] = { ...p, status: e.ok ? "done" : "error", summary: p.summary ?? (e.summary ? toolSummaryText(e.summary) : e.summary), input: e.input };
      }
      // todo18 D: approved, then the tool failed (target gone): the card says so.
      if (!e.ok) {
        const j = at((p) => p.type === "approval" && p.toolCallId === e.id && p.state === "approved");
        if (j >= 0) parts[j] = { ...(parts[j] as Extract<MessagePart, { type: "approval" }>), failed: e.summary || "The change didn't apply." };
      }
      return { ...m, parts };
    }
    case "approval":
      parts.push({ type: "approval", id: e.approvalId, toolName: e.toolName, summary: e.summary, inputPreview: e.inputPreview, state: "pending", expiresAt: e.expiresAt, detail: e.detail, toolCallId: e.toolCallId });
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
    case "custom": {
      // todo22 W4: a part another tab added to this run's message (card, boot, change).
      const v = e.name === "ui_part" ? (e.value as { part?: MessagePart } | null) : null;
      const part = v?.part;
      if (!part || !("id" in part)) return m;
      const i = at((p) => p.type === part.type && "id" in p && p.id === part.id);
      if (i >= 0) parts[i] = part;
      else parts.push(part);
      return { ...m, parts };
    }
    case "error":
      return { ...m, error: e.message };
    case "done":
      return e.status === "cancelled" ? { ...m, stopped: true, runStatus: e.status } : { ...m, runStatus: e.status };
    default:
      return m;
  }
}

const nowIso = () => new Date().toISOString();
const localChatId = () => `conv-${crypto.randomUUID()}`;
const ts = (v: number | string) => (typeof v === "number" ? v : Date.parse(v) || 0);
const newestFirst = (a: ChatSummary, b: ChatSummary) => ts(b.updatedAt) - ts(a.updatedAt) || ts(b.createdAt) - ts(a.createdAt);
/** The service answered "no such route" or isn't there: the cache carries on alone. */
const offline = (e: unknown) => !(e instanceof AgentHttpError) || e.status === 404 || e.status === 405 || e.status >= 500;

export const useAgent = create<AgentState>()(
  persist(
    (set, get) => {
      const patchThread = (key: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) =>
        set((s) => ({ threads: { ...s.threads, [key]: (s.threads[key] ?? []).map((m) => (m.id === messageId ? fn(m) : m)) } }));
      const patchMessage = (projectId: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) => patchThread(threadKey(get(), projectId), messageId, fn);
      const runKey = (a: ActiveRun) => a.chatId;
      const setRun = (chatId: string, run: ActiveRun | null) =>
        set((s) => {
          const runs = { ...s.runs };
          if (run) runs[chatId] = run;
          else delete runs[chatId];
          return { runs };
        });
      const setStreaming = (chatId: string, on: boolean) =>
        set((s) => {
          const streaming = { ...s.streaming };
          if (on) streaming[chatId] = true;
          else delete streaming[chatId];
          return { streaming };
        });
      const addChat = (projectId: string, chat: ChatSummary) => {
        set((s) => ({
          chats: { ...s.chats, [projectId]: [chat, ...(s.chats[projectId] ?? []).filter((c) => c.id !== chat.id)].sort(newestFirst) },
          conversations: { ...s.conversations, [projectId]: { activeSessionId: chat.id } },
        }));
        rememberActive(projectId, chat.id);
      };
      /** todo22 W4: the chat's service session, or null while it only exists here (`conv-…` made offline). */
      const serverSession = (chatId: string) => {
        const id = get().sessions[chatId]?.sessionId ?? chatId;
        return id.startsWith("conv-") && !get().sessions[chatId] ? null : id;
      };
      /** todo22 W4 (D3): the open chat per project is a person pref, so another device opens the same one. */
      const rememberActive = (projectId: string, chatId: string) => void putPref(activeChatPref(projectId), chatId).catch(() => {});
      /**
       * todo22 W4: parts the browser adds to a message (cards, boots, environment changes) are
       * recorded on the service so the thread replays them on any device. `ids`: only these parts.
       */
      const recordParts = (chatId: string, messageId: string, ids?: string[]) => {
        const sid = serverSession(chatId);
        if (!sid) return;
        const m = (get().threads[chatId] ?? []).find((x) => x.id === messageId);
        if (!m || m.role !== "assistant") return;
        for (const p of m.parts) {
          if ((p.type !== "card" && p.type !== "boot" && p.type !== "change") || (ids && !ids.includes(p.id))) continue;
          void postUiPart(sid, { messageId, ...(m.runId ? { runId: m.runId } : {}), part: p }).catch(() => {
            // Offline or an old service: the cache still has it here.
          });
        }
      };
      /** todo22 W4: chat notes live on the session (`PATCH notes`); the cache mirrors the open chat's. */
      const saveNotes = (projectId: string, notes: string[]) => {
        const chatId = get().conversations[projectId]?.activeSessionId;
        const sid = chatId ? serverSession(chatId) : null;
        if (sid) void updateSession(sid, { notes }).catch(() => {});
      };
      const summary = (s: AgentState, projectId: string, id: string) => {
        const chat = (s.chats[projectId] ?? []).find((c) => c.id === id);
        const title = chat ? chatTitle(s, chat) : chatTitle(s, { id, title: null });
        return { id, ...(title !== "New chat" ? { title } : {}) };
      };

      /** Make a chat on the server (an agent session in the project); a local id when the service can't. */
      async function createChat(projectId: string, profile: ProfileName, restricted = false) {
        try {
          const tools = sessionTools(profile);
          // A drop waits on this: give up after a few seconds and carry on with a local chat.
          const giveUp = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000));
          const make = async () =>
            createSession({
              projectId,
              profile,
              clientTools: tools.clientTools,
              catalogPrompt: tools.catalogPrompt,
              restricted,
              kernelToken: await kernelToken(projectId, profile).catch(() => undefined),
            });
          const res = (await Promise.race([giveUp, make()])) as Partial<CreateSessionResponse> & { session?: ChatSummary };
          const id = res.session?.id ?? res.sessionId;
          if (!id) throw new Error("The agent service didn't return a session");
          set((s) => ({ sessions: { ...s.sessions, [id]: { sessionId: id, profile: res.profile ?? profile } } }));
          return res.session ?? { id, projectId, title: null, createdAt: nowIso(), updatedAt: nowIso() };
        } catch {
          // Degrade (todo20): the thread works from the cache; the first send makes the server session.
          return { id: localChatId(), projectId, title: null, createdAt: nowIso(), updatedAt: nowIso() };
        }
      }

      /** Run a client tool the service asked for, then post its result (once per call id). */
      async function clientTool(a: ActiveRun, e: Extract<AgentEvent, { type: "client-tool" }>) {
        if (a.answered.includes(e.callId)) return;
        a.answered.push(e.callId);
        setRun(a.chatId, { ...a });
        let outcome: ClientToolOutcome;
        if (e.name === REFRESH_TOKEN_TOOL) {
          // todo18 D: the service's delegated token expired mid-run; mint a fresh one (no host needed).
          const profile = get().sessions[runKey(a)]?.profile ?? get().profile;
          const token = await kernelToken(a.projectId, profile).catch(() => undefined);
          await answerClientTool(a.runId, e.callId, token ? { ok: true, output: { token } } : { ok: false, output: { error: "Could not refresh access" } }).catch(() => {});
          return;
        }
        if (!host || host.projectId !== a.projectId) outcome = { ok: false, output: { error: STUDIO_CLOSED }, summary: "The Studio isn't open" };
        else {
          try {
            let t = toolAborts.get(a.chatId);
            if (!t) toolAborts.set(a.chatId, (t = { projectId: a.projectId, ctl: new AbortController() }));
            outcome = await raceAbort(host.runTool(e.name, (e.input ?? {}) as Record<string, unknown>), t.ctl.signal, () => ({
              ok: false,
              output: { error: host && host.projectId === a.projectId ? TOOL_STOPPED : STUDIO_CLOSED },
              summary: "Stopped",
            }));
          } catch (err) {
            outcome = { ok: false, output: { error: err instanceof Error ? err.message : String(err) } };
          }
        }
        patchThread(runKey(a), a.messageId, (m) => {
          const parts = [...m.parts];
          const i = parts.findIndex((p) => p.type === "tool" && p.id === e.callId);
          const summary = outcome.summary ?? plainSummary(outcome.output);
          if (i >= 0 && summary) parts[i] = { ...(parts[i] as Extract<MessagePart, { type: "tool" }>), summary };
          if (outcome.card) parts.push({ type: "card", id: e.callId, card: outcome.card, state: "open" });
          if (outcome.change) parts.push({ type: "change", id: e.callId, ...outcome.change });
          return { ...m, parts };
        });
        if (outcome.card || outcome.change) recordParts(runKey(a), a.messageId, [e.callId]);
        // Card tools were already answered by the service; everything else waits for this post.
        if (!CARD_TOOL_NAMES.has(e.name)) {
          await answerClientTool(a.runId, e.callId, { ok: outcome.ok, output: outcome.output }).catch(() => {
            // 409: timed out or cancelled meanwhile; the service already told the model.
          });
        }
      }

      async function follow(a: ActiveRun) {
        const p = a.chatId;
        controllers.get(p)?.abort();
        const ctl = new AbortController();
        controllers.set(p, ctl);
        streamed.set(a.runId, { projectId: p, messageId: a.messageId, chatId: a.chatId });
        setRun(p, a);
        setStreaming(p, true);
        set({ followedElsewhere: null });
        followChannel?.postMessage({ type: "follow", runId: a.runId, tab: TAB_ID });
        try {
          await followRun(
            a.runId,
            a.lastSeq,
            async (e) => {
              const cur = get().runs[p];
              if (!cur || cur.runId !== a.runId) return;
              const updated = sessionUpdate(e);
              if (updated) get().applySession(updated);
              patchThread(runKey(cur), cur.messageId, (m) => reduce(m, e));
              if (e.type === "client-tool") void clientTool(cur, e);
              setRun(p, { ...cur, lastSeq: e.seq });
            },
            ctl.signal,
            (state) => patchThread(runKey(a), a.messageId, (m) => ({ ...m, reconnecting: state === "reconnecting" })),
          );
        } catch (err) {
          if (!ctl.signal.aborted && !handedOff.has(ctl)) {
            const message = err instanceof Error ? err.message : String(err);
            patchThread(runKey(a), a.messageId, (m) => ({ ...m, error: m.error ?? message }));
          }
        } finally {
          if (handedOff.has(ctl)) {
            // Another tab follows it now: leave the message as it is; that tab finishes it.
            handedOff.delete(ctl);
            if (controllers.get(p) === ctl) controllers.delete(p);
            setStreaming(p, false);
          } else if (controllers.get(p) === ctl) {
            controllers.delete(p);
            const cur = get().runs[p];
            const key = cur?.runId === a.runId ? runKey(cur) : runKey(a);
            const messageId = cur?.runId === a.runId ? cur.messageId : a.messageId;
            // Tools still marked running when a run ends were cut off.
            patchThread(key, messageId, (m) => ({
              ...m,
              reconnecting: false,
              parts: m.parts.map((x) =>
                x.type === "tool" && x.status === "running" ? { ...x, status: "error" as const, summary: x.summary ?? "Stopped" } : x.type === "approval" && x.state === "pending" ? { ...x, state: "expired" as const } : x,
              ),
            }));
            setStreaming(p, false);
            if (get().runs[p]?.runId === a.runId) setRun(p, null);
            // A reply that finished while another chat was open: the rail shows a dot.
            if (get().conversations[a.projectId]?.activeSessionId !== p) set((s) => ({ unread: { ...s.unread, [p]: true } }));
            followChannel?.postMessage({ type: "ended", runId: a.runId, tab: TAB_ID });
          }
        }
      }

      /**
       * The chat's service session, normally the chat's own id. Never deletes one (a session is a
       * chat, todo20 D2): a chat made offline, or one the service lost (404), is (re)made under its
       * own id (`sessionId`, idempotent on the service); a profile change makes a new session.
       */
      async function ensureSession(projectId: string, chatId: string, opts: SendOptions, fresh = false) {
        const cur = get().sessions[chatId];
        if (cur && cur.profile === opts.profile && !fresh) return cur.sessionId;
        // todo22 W4: the chat's profile is a session field; the service switches it between runs.
        if (cur && !fresh && cur.sessionId === chatId && !chatId.startsWith("conv-")) {
          const res = await updateSession(chatId, { profile: opts.profile }).catch(() => null);
          if (res?.session?.profile === opts.profile) {
            set((s) => ({ sessions: { ...s.sessions, [chatId]: { sessionId: chatId, profile: opts.profile } } }));
            return chatId;
          }
        }
        const sameId = !cur || cur.profile === opts.profile;
        const res = await createSession({
          ...(sameId ? { sessionId: chatId } : {}),
          projectId,
          profile: opts.profile,
          clientTools: opts.clientTools,
          catalogPrompt: opts.catalogPrompt,
          restricted: opts.restricted,
          kernelToken: await kernelToken(projectId, opts.profile),
        });
        set((s) => ({ sessions: { ...s.sessions, [chatId]: { sessionId: res.sessionId, profile: res.profile } } }));
        return res.sessionId;
      }

      const stopRun = (chatId: string) => {
        // Browser-side tool work stops now; its failure is posted to the service by clientTool.
        abortTools((c) => c === chatId);
        const a = get().runs[chatId];
        if (!a) return controllers.get(chatId)?.abort();
        // Cancel on the service; the stream then ends with `done: cancelled`. Fall back to local abort.
        cancelRun(a.runId).catch(() => controllers.get(chatId)?.abort());
        setTimeout(() => {
          if (get().runs[chatId]?.runId === a.runId) controllers.get(chatId)?.abort();
        }, 5000);
      };
      const forget = (projectId: string, chatId: string) =>
        set((s) => {
          const threads = { ...s.threads };
          delete threads[chatId];
          const sessions = { ...s.sessions };
          delete sessions[chatId];
          const chats = (s.chats[projectId] ?? []).filter((c) => c.id !== chatId);
          const conversations = { ...s.conversations };
          if (conversations[projectId]?.activeSessionId === chatId) {
            if (chats[0]) conversations[projectId] = { activeSessionId: chats[0].id };
            else delete conversations[projectId];
          }
          return { threads, sessions, conversations, chats: { ...s.chats, [projectId]: chats } };
        });
      const deleteOnServer = (projectId: string, chatId: string) => {
        if (get().runs[chatId]) stopRun(chatId);
        const session = get().sessions[chatId]?.sessionId ?? (chatId.startsWith("conv-") ? undefined : chatId);
        if (session) void deleteSession(session).catch(() => {});
        // todo13 D15: a conversation that shared files is gone; its folder stays in Files, renamed.
        if ((get().threads[chatId] ?? []).some((m) => m.parts.some((p) => p.type === "drop")))
          void api(`/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(chatId)}/deleted`, { method: "POST" }).catch(() => {});
      };

      return {
        threads: {},
        sessions: {},
        notes: {},
        conversations: {},
        chats: {},
        runs: {},
        streaming: {},
        lastOpened: {},
        unread: {},
        // One assistant (the specialists, builder and coder, are reached through offer_specialist cards).
        profile: "assistant",
        followedElsewhere: null,
        blockedBy: null,
        setProfile: (profile) => set({ profile }),
        setHost: (h) => {
          // The panel closed (or moved to another project): browser tools in flight fail now.
          if (!h || (host && h.projectId !== host.projectId)) {
            const was = host?.projectId;
            abortTools((_c, p) => !was || p === was);
          }
          host = h;
        },
        conversation: (projectId) => {
          const s = get();
          const cur = s.conversations[projectId];
          if (cur) return summary(s, projectId, cur.activeSessionId);
          // Nothing loaded yet: a local chat now (its first send makes the server session).
          const id = localChatId();
          addChat(projectId, { id, projectId, title: null, createdAt: nowIso(), updatedAt: nowIso() });
          return { id };
        },
        ensureConversation: async (projectId, opts) => {
          const cur = get().conversations[projectId];
          if (cur) return summary(get(), projectId, cur.activeSessionId);
          let p = creating.get(projectId);
          if (!p) {
            p = createChat(projectId, get().profile, opts?.restricted).then((chat) => {
              // Someone picked a chat meanwhile (the list loaded): keep theirs, list this one.
              if (get().conversations[projectId]) {
                set((s) => ({ chats: { ...s.chats, [projectId]: [...(s.chats[projectId] ?? []).filter((c) => c.id !== chat.id), chat].sort(newestFirst) } }));
                return summary(get(), projectId, get().conversations[projectId]!.activeSessionId);
              }
              addChat(projectId, chat);
              return { id: chat.id };
            });
            creating.set(projectId, p);
            void p.finally(() => creating.delete(projectId));
          }
          return p;
        },
        loadChats: async (projectId) => {
          let listed: ChatSummary[];
          try {
            listed = (await listChats(projectId)).sessions ?? [];
          } catch (e) {
            if (offline(e)) return;
            throw e;
          }
          // todo22 W4: no chat open here yet: the one the person had open (any device), when it's listed.
          let remembered: string | undefined;
          if (!get().conversations[projectId]) {
            const v = await fetchPrefs()
              .then((p) => p[activeChatPref(projectId)])
              .catch(() => undefined);
            if (typeof v === "string" && listed.some((c) => c.id === v)) remembered = v;
          }
          set((s) => {
            const known = new Set(listed.map((c) => c.id));
            // Chats made here and not on the server (offline ones) stay listed.
            // A chat made offline whose first send made a server session is listed once, under its own id.
            const local = (s.chats[projectId] ?? []).filter((c) => !known.has(c.id));
            const mapped = new Set(local.map((c) => s.sessions[c.id]?.sessionId).filter(Boolean));
            const merged = [...listed.filter((c) => !mapped.has(c.id) && !pendingDeletes.has(c.id)), ...local].sort(newestFirst);
            const active = s.conversations[projectId]?.activeSessionId ?? remembered ?? merged[0]?.id;
            // todo22 W4: last opened (any device) and the open chat's notes come from the service.
            const lastOpened = { ...s.lastOpened };
            for (const c of listed) if (c.lastOpenedAt && (!lastOpened[c.id] || ts(c.lastOpenedAt) > ts(lastOpened[c.id]!))) lastOpened[c.id] = c.lastOpenedAt;
            const open = listed.find((c) => c.id === active);
            const sessions = { ...s.sessions };
            for (const c of listed) if (c.profile && (!sessions[c.id] || sessions[c.id]!.sessionId === c.id)) sessions[c.id] = { sessionId: c.id, profile: c.profile };
            return {
              chats: { ...s.chats, [projectId]: merged },
              lastOpened,
              sessions,
              ...(open?.notes ? { notes: { ...s.notes, [projectId]: open.notes } } : {}),
              ...(active ? { conversations: { ...s.conversations, [projectId]: { activeSessionId: active } } } : {}),
            };
          });
          const active = get().conversations[projectId]?.activeSessionId;
          if (active) await get().loadThread(active);
        },
        loadThread: async (chatId) => {
          if (chatId.startsWith("conv-")) return;
          let messages: ChatMessage[];
          try {
            messages = (await fetchThread<ChatMessage>(chatId)).messages ?? [];
          } catch {
            return;
          }
          // A run streaming into this chat owns its tail; the cache is fresher until it ends.
          if (get().runs[chatId]) return;
          const cached = get().threads[chatId] ?? [];
          if (!messages.length) return;
          set((s) => ({ threads: { ...s.threads, [chatId]: mergeThread(messages, cached) } }));
        },
        selectChat: (projectId, chatId) => {
          // Switching never stops a run: the old chat's stream keeps going to its own thread.
          set((s) => {
            const now = nowIso();
            const prev = s.conversations[projectId]?.activeSessionId;
            const unread = { ...s.unread };
            delete unread[chatId];
            return {
              conversations: { ...s.conversations, [projectId]: { activeSessionId: chatId } },
              lastOpened: { ...s.lastOpened, [chatId]: now, ...(prev ? { [prev]: now } : {}) },
              unread,
            };
          });
          rememberActive(projectId, chatId);
          const sid = serverSession(chatId);
          if (sid)
            void updateSession(sid, { opened: true })
              .then((r) => {
                const chat = r?.session;
                if (!chat || get().conversations[projectId]?.activeSessionId !== chatId) return;
                set((s) => ({ notes: { ...s.notes, [projectId]: chat.notes ?? [] } }));
              })
              .catch(() => {});
          void get().loadThread(chatId);
        },
        newChat: async (projectId, opts) => {
          set((s) => {
            const conversations = { ...s.conversations };
            delete conversations[projectId];
            // A new chat starts with the assistant, not with a specialist the last one handed off to.
            return { conversations, profile: "assistant", notes: { ...s.notes, [projectId]: [] } };
          });
          await get().ensureConversation(projectId, opts);
        },
        reset: (projectId) => void get().newChat(projectId),
        deleteChat: (projectId, chatId) => {
          deleteOnServer(projectId, chatId);
          forget(projectId, chatId);
        },
        removeChat: (projectId, chatId, delayMs = 6000) => {
          const s0 = get();
          const chat = (s0.chats[projectId] ?? []).find((c) => c.id === chatId);
          const wasOpen = s0.conversations[projectId]?.activeSessionId === chatId;
          const thread = s0.threads[chatId];
          const session = s0.sessions[chatId];
          set((s) => {
            const chats = (s.chats[projectId] ?? []).filter((c) => c.id !== chatId);
            const conversations = { ...s.conversations };
            if (wasOpen) {
              if (chats[0]) conversations[projectId] = { activeSessionId: chats[0].id };
              else delete conversations[projectId];
            }
            return { chats: { ...s.chats, [projectId]: chats }, conversations };
          });
          const timer = setTimeout(() => {
            pendingDeletes.delete(chatId);
            deleteOnServer(projectId, chatId);
            forget(projectId, chatId);
          }, delayMs);
          pendingDeletes.set(chatId, timer);
          return () => {
            if (!pendingDeletes.has(chatId)) return;
            clearTimeout(pendingDeletes.get(chatId));
            pendingDeletes.delete(chatId);
            if (!chat) return;
            set((s) => ({
              chats: { ...s.chats, [projectId]: [chat, ...(s.chats[projectId] ?? []).filter((c) => c.id !== chatId)].sort(newestFirst) },
              ...(thread ? { threads: { ...s.threads, [chatId]: thread } } : {}),
              ...(session ? { sessions: { ...s.sessions, [chatId]: session } } : {}),
              ...(wasOpen ? { conversations: { ...s.conversations, [projectId]: { activeSessionId: chatId } } } : {}),
            }));
          };
        },
        renameChat: async (projectId, chatId, title) => {
          const t = title.trim().slice(0, 80);
          if (!t) return;
          const patch = (fields: Partial<ChatSummary>) =>
            set((s) => ({ chats: { ...s.chats, [projectId]: (s.chats[projectId] ?? []).map((c) => (c.id === chatId ? { ...c, ...fields } : c)) } }));
          const before = (get().chats[projectId] ?? []).find((c) => c.id === chatId);
          patch({ title: t, titleBy: "person" });
          if (chatId.startsWith("conv-")) return;
          try {
            const res = await renameSession(get().sessions[chatId]?.sessionId ?? chatId, t);
            if (res?.session) get().applySession(res.session);
          } catch (e) {
            if (!offline(e) && before) patch({ title: before.title, titleBy: before.titleBy ?? null });
            throw e;
          }
        },
        branchChat: async (projectId, chatId, messageIdx) => {
          const source = get().sessions[chatId]?.sessionId ?? chatId;
          if (source.startsWith("conv-")) return null;
          const res = await branchSession(source, messageIdx);
          const chat: ChatSummary = { ...res.session, projectId: res.session.projectId ?? projectId, branchedFrom: res.session.branchedFrom ?? { sessionId: chatId, messageIdx } };
          const cached = (get().threads[chatId] ?? []).slice(0, messageIdx + 1);
          set((s) => ({
            sessions: { ...s.sessions, [chat.id]: { sessionId: chat.id, profile: s.sessions[chatId]?.profile ?? s.profile } },
            threads: { ...s.threads, [chat.id]: cached },
          }));
          addChat(projectId, chat);
          get().selectChat(projectId, chat.id);
          return chat.id;
        },
        applySession: (session) => {
          const projectId = session.projectId;
          if (!projectId) return;
          set((s) => {
            const list = s.chats[projectId] ?? [];
            if (pendingDeletes.has(session.id)) return {};
            const known = list.some((c) => c.id === session.id);
            const next = known ? list.map((c) => (c.id === session.id ? { ...c, ...session } : c)) : [session, ...list];
            return { chats: { ...s.chats, [projectId]: next.sort(newestFirst) } };
          });
        },
        send: async (projectId, text, opts) => {
          // The chat a reply goes to: the one open now (made on the server if none is yet).
          const chatId = (await get().ensureConversation(projectId, { restricted: opts.restricted })).id;
          const steering = !!get().streaming[chatId] && get().runs[chatId];
          const parts: MessagePart[] = [...(opts.drop ? [{ type: "drop" as const, id: opts.drop.dropId }] : []), ...(text ? [{ type: "text" as const, text }] : [])];
          const user: ChatMessage = { id: opts.messageId ?? crypto.randomUUID(), role: "user", parts };
          const assistant: ChatMessage = { id: crypto.randomUUID(), role: "assistant", parts: [] };
          set((s) => ({
            threads: { ...s.threads, [chatId]: [...(s.threads[chatId] ?? []), user, assistant] },
            chats: {
              ...s.chats,
              [projectId]: (s.chats[projectId] ?? [])
                .map((c) => (c.id === chatId ? { ...c, updatedAt: nowIso() } : c))
                .sort(newestFirst),
            },
          }));
          const notes = get().notes[projectId] ?? [];
          const context = [opts.context, ...notes].join("\n");
          try {
            let sessionId = await ensureSession(projectId, chatId, opts);
            await opts.beforeSend?.();
            const req = { text, context, snapshot: opts.snapshot, kernelToken: await kernelToken(projectId, opts.profile), ...(opts.drop ? { drop: opts.drop } : {}) };
            const res = await sendMessage(sessionId, req).catch(async (err) => {
              // The service restarted without this session: start a fresh one (history stays on screen).
              if (!(err instanceof AgentHttpError) || err.status !== 404) throw err;
              sessionId = await ensureSession(projectId, chatId, opts, true);
              return sendMessage(sessionId, req);
            });
            set((s) => ({ notes: { ...s.notes, [projectId]: [] } }));
            if (notes.length) saveNotes(projectId, []);
            if (steering && res.steered && get().runs[chatId]?.runId === res.runId) {
              // Same run: route the rest of its events to the new assistant message.
              streamed.set(res.runId, { projectId, messageId: assistant.id, chatId });
              setRun(chatId, { ...get().runs[chatId]!, messageId: assistant.id });
              return;
            }
            await follow({ projectId, chatId, runId: res.runId, messageId: assistant.id, lastSeq: 0, answered: [] });
          } catch (e) {
            patchThread(chatId, assistant.id, (m) => ({ ...m, error: e instanceof Error ? e.message : String(e) }));
            setStreaming(chatId, false);
          }
        },
        takeOver: () => {
          const id = get().followedElsewhere;
          const a = Object.values(get().runs).find((r) => r.runId === id);
          if (!a || controllers.has(a.chatId)) return;
          void follow(a);
        },
        reattach: (projectId) => {
          for (const a of projectRuns(get(), projectId)) {
            if (controllers.has(a.chatId) || get().followedElsewhere === a.runId) continue;
            void follow(a);
          }
        },
        stop: (projectId, chatId) => {
          const p = projectId ?? host?.projectId;
          const c = chatId ?? (p ? threadKey(get(), p) : undefined);
          if (c) stopRun(c);
          else abortTools(() => true);
        },
        addNote: (projectId, note) => {
          set((s) => ({ notes: { ...s.notes, [projectId]: [...(s.notes[projectId] ?? []), note] } }));
          saveNotes(projectId, get().notes[projectId] ?? []);
        },
        setCardState: (projectId, messageId, cardId, state) => {
          patchMessage(projectId, messageId, (m) => ({ ...m, parts: m.parts.map((p) => (p.type === "card" && p.id === cardId ? { ...p, state } : p)) }));
          recordParts(threadKey(get(), projectId), messageId, [cardId]);
        },
        setPart: (projectId, messageId, partId, patch) => {
          patchMessage(projectId, messageId, (m) => ({
            ...m,
            parts: m.parts.map((p) => ("id" in p && p.id === partId ? ({ ...p, ...patch } as MessagePart) : p)),
          }));
          recordParts(threadKey(get(), projectId), messageId, [partId]);
        },
        decide: async (projectId, messageId, approvalId, decision) => {
          const key = threadKey(get(), projectId);
          const setState = (state: ApprovalState) =>
            patchThread(key, messageId, (m) => ({ ...m, parts: m.parts.map((p) => (p.type === "approval" && p.id === approvalId ? { ...p, state } : p)) }));
          // Pending until the service agrees (a second tab or an expiry may have decided first).
          const part = (get().threads[key] ?? []).find((m) => m.id === messageId)?.parts.find((p) => p.type === "approval" && p.id === approvalId) as
            | Extract<MessagePart, { type: "approval" }>
            | undefined;
          if (part && (part.state !== "pending" || part.expiresAt <= Date.now())) {
            if (part.state === "pending") setState("expired");
            return;
          }
          try {
            await decideApproval(approvalId, { decision });
            setState(decision === "approve" ? "approved" : "rejected");
          } catch (err) {
            const status = err instanceof AgentHttpError ? err.status : 0;
            // 404/409/410: decided elsewhere or expired. Anything else: still pending, try again.
            if (status === 404 || status === 409 || status === 410) setState("expired");
            // Otherwise the card stays pending and the person can try again.
          }
        },
        addPart: (projectId, messageId, part) => {
          patchMessage(projectId, messageId, (m) => (m.parts.some((p) => "id" in p && p.id === (part as { id?: string }).id && p.type === part.type) ? m : { ...m, parts: [...m.parts, part] }));
          if ("id" in part && part.id) recordParts(threadKey(get(), projectId), messageId, [part.id]);
        },
        attachBoot: (runId, bootId) => {
          const r = Object.values(get().runs).find((x) => x.runId === runId) ?? streamed.get(runId);
          if (!r) return false;
          patchThread(r.chatId, r.messageId, (m) =>
            m.parts.some((p) => p.type === "boot" && p.id === bootId) ? m : { ...m, parts: [...m.parts, { type: "boot", id: bootId }] },
          );
          recordParts(r.chatId, r.messageId, [bootId]);
          return true;
        },
        addLocal: (projectId, text, parts) => {
          const user: ChatMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
          const reply: ChatMessage = { id: crypto.randomUUID(), role: "assistant", parts };
          const key = threadKey(get(), projectId);
          set((s) => ({ threads: { ...s.threads, [key]: [...(s.threads[key] ?? []), user, reply] } }));
          return reply.id;
        },
      };
    },
    {
      // Per person (todo14 M0): a dev "new person" starts with no conversations.
      name: `${RES}-ai`,
      // Per person (todo15 D1): the name is suffixed with the person at each read and write.
      storage: createJSONStorage(() => personStorage(() => localStorage)),
      version: 5,
      migrate: (persisted, version) => migrateAgent(persisted, version) as never,
      // todo22 W4 (D3): a cache of the service's chats and threads per project (refilled on open), plus
      // the tab's runs to reattach. Notes, profiles, last-opened and the open chat live on the server.
      partialize: (s) => ({ threads: s.threads, sessions: s.sessions, runs: s.runs, conversations: s.conversations, chats: s.chats, lastOpened: s.lastOpened }),
    },
  ),
);

/**
 * todo22 W4: every part type is on the server: the transcript's (text, reasoning, tools, drops) and
 * the recorded ones (cards, boots, changes the browser posted; approvals, artifacts and statuses
 * the service recorded). A replayed approval is decided or expired (`used`), never live again.
 */
export const SERVER_PARTS: ReadonlySet<MessagePart["type"]> = new Set<MessagePart["type"]>(["text", "reasoning", "tool", "drop", "card", "approval", "change", "artifact", "status", "boot"]);

/** todo22 W4: the server's thread is the whole thread; the cache has nothing left to add. */
export function mergeThread(server: ChatMessage[], _cached: ChatMessage[]): ChatMessage[] {
  return server;
}

/** todo22 W4: the `user_prefs` key of the chat open in a project. */
export const activeChatPref = (projectId: string) => `chat.active:${projectId}`;

/**
 * v1–3 → v4 (todo20 D2): one conversation per project (`conversations[p] = { id, title }`,
 * `threads[p]`, `sessions[p]`, `active`) becomes chats keyed by id (`conversations[p] =
 * { activeSessionId }`, `threads[chatId]`, `sessions[chatId]`, `runs[p]`).
 */
export function migrateAgent(persisted: unknown, version: number): Record<string, unknown> {
  const old = (persisted ?? {}) as {
    threads?: Record<string, ChatMessage[]>;
    sessions?: Record<string, { sessionId: string; profile: ProfileName }>;
    conversations?: Record<string, { id?: string; title?: string; activeSessionId?: string }>;
    active?: ActiveRun | null;
  } & Record<string, unknown>;
  if (version >= 5) return old;
  if (version === 4) return { ...old, runs: rekeyRuns(old.runs as Record<string, ActiveRun> | undefined, old.conversations as Record<string, { activeSessionId?: string }> | undefined) };
  const threads: Record<string, ChatMessage[]> = {};
  const sessions: Record<string, { sessionId: string; profile: ProfileName }> = {};
  const conversations: Record<string, { activeSessionId: string }> = {};
  const chats: Record<string, ChatSummary[]> = {};
  const projects = new Set([...Object.keys(old.threads ?? {}), ...Object.keys(old.conversations ?? {})]);
  for (const p of projects) {
    const thread = old.threads?.[p] ?? [];
    const conv = old.conversations?.[p];
    if (!thread.length && !conv) continue;
    const id = conv?.activeSessionId ?? conv?.id ?? localChatId();
    threads[id] = thread;
    // v3 and older wiped sessions on migrate; a v3 session (version 3 only) carries on.
    if (version === 3 && old.sessions?.[p]) sessions[id] = old.sessions[p]!;
    conversations[p] = { activeSessionId: id };
    chats[p] = [{ id, projectId: p, title: conv?.title ?? null, createdAt: nowIso(), updatedAt: nowIso() }];
  }
  const runs: Record<string, ActiveRun> = {};
  const chatOf = old.active ? conversations[old.active.projectId]?.activeSessionId : undefined;
  if (version === 3 && old.active && chatOf) runs[chatOf] = { ...old.active, chatId: chatOf };
  return { ...old, threads, sessions, conversations, chats, notes: {}, runs, profile: "assistant", active: undefined, running: undefined };
}

/** v4 → v5 (todo21 D6): runs keyed by project become runs keyed by their chat. */
function rekeyRuns(runs: Record<string, ActiveRun> | undefined, conversations: Record<string, { activeSessionId?: string }> | undefined): Record<string, ActiveRun> {
  const out: Record<string, ActiveRun> = {};
  for (const [k, r] of Object.entries(runs ?? {})) {
    const chatId = r.chatId ?? conversations?.[k]?.activeSessionId;
    if (chatId) out[chatId] = { ...r, chatId };
  }
  return out;
}

/** todo21: the service's `session.updated` run event (top-level, or as an AG-UI custom event). */
function sessionUpdate(e: AgentEvent): ChatSummary | null {
  const x = e as unknown as { type: string; session?: ChatSummary; name?: string; value?: unknown };
  if (x.type === "session.updated" && x.session) return x.session;
  if (x.type === "custom" && x.name === "session.updated" && x.value && typeof x.value === "object") {
    const v = x.value as { session?: ChatSummary } & Partial<ChatSummary>;
    return v.session ?? (v.id ? (v as ChatSummary) : null);
  }
  return null;
}

// todo18 D: another tab started following this run: stop streaming here and say so.
followChannel?.addEventListener("message", (ev: MessageEvent<{ type?: string; runId?: string; tab?: string }>) => {
  const d = ev.data;
  if (!d || d.tab === TAB_ID) return;
  const s = useAgent.getState();
  const a = Object.values(s.runs).find((r) => r.runId === d.runId);
  if (!a) return;
  if (d.type === "ended") {
    // The tab that followed it saw it end; this tab's copy of the thread is older (reload to see it).
    useAgent.setState((st) => {
      const runs = { ...st.runs };
      delete runs[a.chatId];
      const streaming = { ...st.streaming };
      delete streaming[a.chatId];
      return { runs, streaming, followedElsewhere: null };
    });
    return;
  }
  if (d.type !== "follow") return;
  const ctl = controllers.get(a.chatId);
  if (ctl) {
    handedOff.add(ctl);
    ctl.abort();
  }
  useAgent.setState({ followedElsewhere: d.runId });
});

// Another person (or organization) signed in: load theirs, or start empty (todo15 D1).
followPerson(useAgent, () => localStorage);
