import { create } from "zustand";
import { persist } from "zustand/middleware";
import { streamAgent } from "@/lib/agent/client";
import type { AgentCard, AgentContext, AgentEvent, ChatTurn } from "@/lib/agent/protocol";
import { RES } from "@studio/plugin-contracts/naming";

export type CardState = "open" | "applied" | "dismissed";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; title: string; status: "running" | "done" | "error"; summary?: string; input?: unknown }
  | { type: "card"; id: string; card: AgentCard; state: CardState };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  /** Assistant only. */
  model?: string;
  error?: string;
  stopped?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

interface AgentState {
  /** Conversations per dataset. */
  threads: Record<string, ChatMessage[]>;
  /** The expert agreed to share this dataset's text context with the model provider. */
  consent: boolean;
  /** Dataset whose run is streaming, if any. */
  running: string | null;
  setConsent: (v: boolean) => void;
  send: (projectId: string, text: string, context: AgentContext) => Promise<void>;
  stop: () => void;
  reset: (projectId: string) => void;
  setCardState: (projectId: string, messageId: string, cardId: string, state: CardState) => void;
}

let controller: AbortController | null = null;

/** What the model is told about earlier turns: their text plus one line per tool call and card. */
function toTurns(messages: ChatMessage[]): ChatTurn[] {
  return messages
    .map((m) => ({
      role: m.role,
      content: m.parts
        .map((p) => {
          if (p.type === "text") return p.text;
          if (p.type === "tool") return `[${p.name}: ${p.summary ?? p.status}]`;
          if (p.type === "card") return `[card ${p.card.kind} ${p.state}]`;
          return "";
        })
        .filter(Boolean)
        .join("\n"),
    }))
    .filter((t) => t.content.trim());
}

function reduce(m: ChatMessage, e: AgentEvent): ChatMessage {
  const parts = [...m.parts];
  const last = parts[parts.length - 1];
  switch (e.type) {
    case "start":
      return { ...m, model: e.model };
    case "text":
      if (last?.type === "text") parts[parts.length - 1] = { ...last, text: last.text + e.delta };
      else parts.push({ type: "text", text: e.delta });
      return { ...m, parts };
    case "reasoning":
      if (last?.type === "reasoning") parts[parts.length - 1] = { ...last, text: last.text + e.delta };
      else parts.push({ type: "reasoning", text: e.delta });
      return { ...m, parts };
    case "tool-call":
      parts.push({ type: "tool", id: e.id, name: e.name, title: e.title, status: "running" });
      return { ...m, parts };
    case "tool-result": {
      const i = parts.findIndex((p) => p.type === "tool" && p.id === e.id);
      if (i >= 0) parts[i] = { ...(parts[i] as Extract<MessagePart, { type: "tool" }>), status: e.ok ? "done" : "error", summary: e.summary, input: e.input };
      if (e.card) parts.push({ type: "card", id: e.id, card: e.card, state: "open" });
      return { ...m, parts };
    }
    case "usage":
      return { ...m, usage: { inputTokens: e.inputTokens, outputTokens: e.outputTokens } };
    case "error":
      return { ...m, error: e.message };
    default:
      return m;
  }
}

export const useAgent = create<AgentState>()(
  persist(
    (set, get) => {
      const patchLast = (projectId: string, fn: (m: ChatMessage) => ChatMessage) =>
        set((s) => {
          const thread = s.threads[projectId] ?? [];
          if (!thread.length) return s;
          return { threads: { ...s.threads, [projectId]: [...thread.slice(0, -1), fn(thread[thread.length - 1])] } };
        });

      return {
        threads: {},
        consent: false,
        running: null,
        setConsent: (consent) => set({ consent }),
        send: async (projectId, text, context) => {
          if (get().running) return;
          const user: ChatMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
          const history = [...(get().threads[projectId] ?? []), user];
          const assistant: ChatMessage = { id: crypto.randomUUID(), role: "assistant", parts: [] };
          set((s) => ({ running: projectId, threads: { ...s.threads, [projectId]: [...history, assistant] } }));
          controller = new AbortController();
          try {
            await streamAgent({ messages: toTurns(history), context }, (e) => patchLast(projectId, (m) => reduce(m, e)), controller.signal);
          } catch (e) {
            if (controller?.signal.aborted) patchLast(projectId, (m) => ({ ...m, stopped: true }));
            else patchLast(projectId, (m) => ({ ...m, error: e instanceof Error ? e.message : String(e) }));
          } finally {
            // Tools still marked running when a run ends were cut off.
            patchLast(projectId, (m) => ({ ...m, parts: m.parts.map((p) => (p.type === "tool" && p.status === "running" ? { ...p, status: "error", summary: "Stopped" } : p)) }));
            controller = null;
            set({ running: null });
          }
        },
        stop: () => controller?.abort(),
        reset: (projectId) => {
          if (get().running === projectId) controller?.abort();
          set((s) => ({ threads: { ...s.threads, [projectId]: [] } }));
        },
        setCardState: (projectId, messageId, cardId, state) =>
          set((s) => ({
            threads: {
              ...s.threads,
              [projectId]: (s.threads[projectId] ?? []).map((m) =>
                m.id !== messageId ? m : { ...m, parts: m.parts.map((p) => (p.type === "card" && p.id === cardId ? { ...p, state } : p)) },
              ),
            },
          })),
      };
    },
    {
      name: `${RES}-ai`,
      version: 1,
      partialize: (s) => ({ consent: s.consent, threads: s.threads }),
    },
  ),
);
