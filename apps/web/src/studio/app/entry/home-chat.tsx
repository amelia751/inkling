import { useEffect } from "react";
import { create } from "zustand";
import { matchPath, useLocation, useSearchParams, type NavigateFunction } from "react-router";
import type { ClientToolSpec } from "@studio/agent-protocol";
import { createHomeSession, fetchThread, followHomeRun, listHomeChats, sendMessage, type ChatSummary } from "@/studio/lib/agent/client";
import { projectUrl } from "@/studio/lib/routes";
import { reduce, useAgent, type ChatMessage } from "@/studio/stores/agent";
import { useShell } from "@/studio/stores/shell";
import { cn } from "@studio/ui/utils";
import { useNewProjectStore } from "./new-project-dialog";

/**
 * todo21 D8 (W5, web): Home's assistant routes. A Home send that isn't a drop goes into a Home
 * chat (an agent session with `scope = "home"`, no project). Its tools are `list_projects`,
 * `open_in_project` (server) and `create_project`, a client tool that opens the new-project
 * dialog so the person still confirms the name. When `open_in_project` returns, the browser
 * goes to that project's new chat (`?chat=<sessionId>`). Its own small store, kept apart from
 * the project chats' `stores/agent.ts`.
 */

export const CREATE_PROJECT_TOOL = "create_project";
export const OPEN_IN_PROJECT_TOOL = "open_in_project";
/** The `?chat=` query a project page reads to open that chat in its assistant panel. */
export const CHAT_PARAM = "chat";

export const HOME_CLIENT_TOOLS: ClientToolSpec[] = [
  {
    name: CREATE_PROJECT_TOOL,
    title: "Creating a project",
    description: "Open the new-project dialog with a suggested name; the person confirms or edits it. Returns {project:{id,title}} or {cancelled:true}.",
    input_schema: { type: "object", properties: { suggestion: { type: "string", description: "Suggested project name" } } },
  },
];

export const projectChatUrl = (projectId: string, sessionId?: string) => (sessionId ? `${projectUrl(projectId)}?${CHAT_PARAM}=${encodeURIComponent(sessionId)}` : projectUrl(projectId));

/** `open_in_project`'s result as the stream carries it: `{projectId, sessionId}` JSON in the summary, else the input's project. */
export function openInProjectTarget(summary: string | undefined, input: unknown): { projectId: string; sessionId?: string } | null {
  try {
    const out = JSON.parse(summary ?? "") as { projectId?: unknown; sessionId?: unknown };
    if (typeof out?.projectId === "string") return { projectId: out.projectId, sessionId: typeof out.sessionId === "string" ? out.sessionId : undefined };
  } catch {
    // Not JSON: fall through.
  }
  const sid = /\bses_[A-Za-z0-9_-]+/.exec(summary ?? "")?.[0];
  const pid = (input as { projectId?: unknown } | null)?.projectId;
  return typeof pid === "string" ? { projectId: pid, sessionId: sid } : null;
}

interface HomeChatState {
  chats: ChatSummary[];
  activeId: string | null;
  threads: Record<string, ChatMessage[]>;
  running: boolean;
  error: string | null;
  load: () => Promise<void>;
  open: (id: string | null) => Promise<void>;
  /** Send into the open Home chat (a new one if none); false when the agent service can't take it. */
  send: (text: string, navigate: NavigateFunction) => Promise<boolean>;
}

const nowIso = () => new Date().toISOString();

export const useHomeChat = create<HomeChatState>()((set, get) => {
  const patch = (id: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) =>
    set((s) => ({ threads: { ...s.threads, [id]: (s.threads[id] ?? []).map((m) => (m.id === messageId ? fn(m) : m)) } }));

  return {
    chats: [],
    activeId: null,
    threads: {},
    running: false,
    error: null,
    load: async () => {
      try {
        const { sessions } = await listHomeChats();
        set({ chats: sessions ?? [] });
      } catch {
        // The agent service is down or predates Home chats: the list stays empty.
      }
    },
    open: async (id) => {
      set({ activeId: id, error: null });
      if (!id || get().threads[id]?.length) return;
      try {
        const { messages } = await fetchThread<ChatMessage>(id);
        set((s) => ({ threads: { ...s.threads, [id]: messages ?? [] } }));
      } catch {
        // Keep the empty thread.
      }
    },
    send: async (text, navigate) => {
      let id = get().activeId;
      let added = false;
      try {
        if (!id) {
          const res = await createHomeSession({ clientTools: HOME_CLIENT_TOOLS });
          id = res.session?.id ?? res.sessionId;
          const chat: ChatSummary = res.session ?? { id, projectId: "", title: text.slice(0, 80), createdAt: nowIso(), updatedAt: nowIso() };
          set((s) => ({ activeId: id, chats: [chat, ...s.chats.filter((c) => c.id !== chat.id)] }));
        }
        const sessionId = id;
        const user: ChatMessage = { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] } as ChatMessage;
        const reply: ChatMessage = { id: crypto.randomUUID(), role: "assistant", parts: [] } as ChatMessage;
        set((s) => ({ running: true, error: null, threads: { ...s.threads, [sessionId]: [...(s.threads[sessionId] ?? []), user, reply] } }));
        added = true;
        const { runId } = await sendMessage(sessionId, { text });
        void followHomeRun(
          runId,
          {
            onEvent: (e) => patch(sessionId, reply.id, (m) => reduce(m, e)),
            createProject: async (suggestion) => {
              const p = await useNewProjectStore.getState().open({ suggestion, stay: true });
              return p ? { project: { id: p.id, title: p.title } } : { cancelled: true };
            },
            opened: (summary, input) => {
              const to = openInProjectTarget(summary, input);
              if (to) navigate(projectChatUrl(to.projectId, to.sessionId));
            },
          },
          new AbortController().signal,
        )
          .catch((err) => set({ error: err instanceof Error ? err.message : String(err) }))
          .finally(() => set({ running: false }));
        return true;
      } catch {
        set({ running: false });
        // Nothing was sent: drop the optimistic messages, the caller falls back to the dialog.
        const key = id;
        if (added && key) set((s) => ({ threads: { ...s.threads, [key]: (s.threads[key] ?? []).slice(0, -2) } }));
        return false;
      }
    },
  };
});

const textOf = (m: ChatMessage) =>
  m.parts
    .filter((p): p is Extract<ChatMessage["parts"][number], { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

/** "Recent chats here" under Home's composer, and the open Home chat's thread. */
export function HomeChats({ className }: { className?: string }) {
  const { chats, activeId, threads, running, error, load, open } = useHomeChat();
  useEffect(() => void load(), [load]);
  const thread = activeId ? (threads[activeId] ?? []) : [];
  if (!chats.length && !thread.length) return null;
  return (
    <section className={cn("mt-6", className)} aria-labelledby="home-chats-heading" data-testid="home-chats">
      {thread.length > 0 && (
        <ol className="mb-4 flex flex-col gap-2" data-testid="home-chat-thread" aria-live="polite">
          {thread.map((m) => (
            <li key={m.id} className={cn("max-w-prose rounded-lg px-3 py-2 text-sm", m.role === "user" ? "self-end bg-generic" : "self-start")} data-role={m.role}>
              {textOf(m) || (m.role === "assistant" && running ? "…" : "")}
            </li>
          ))}
          {error && (
            <li className="text-sm text-danger" role="alert">
              {error}
            </li>
          )}
        </ol>
      )}
      {chats.length > 0 && (
        <>
          <div className="mb-2 flex items-baseline justify-between">
            <h2 id="home-chats-heading" className="text-body-2 font-semibold">
              Recent chats here
            </h2>
            {activeId && (
              <button type="button" className="text-sm text-brand hover:underline" onClick={() => void open(null)} data-testid="home-chat-new">
                New chat
              </button>
            )}
          </div>
          <ul className="flex flex-col" data-testid="home-chat-list">
            {chats.slice(0, 8).map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => void open(c.id)}
                  className={cn("flex h-8 w-full items-center truncate rounded-md px-2 text-left text-sm hover:bg-generic", c.id === activeId ? "text-foreground" : "text-muted-foreground")}
                  aria-current={c.id === activeId || undefined}
                  data-testid="home-chat-item"
                >
                  <span className="truncate">{c.title || "New chat"}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * `/projects/:projectId…?chat=<id>` opens that chat in the project's assistant panel (the
 * Home assistant's `open_in_project` sends people here). Mounted once, in the app shell.
 */
export function ChatParamSync() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const chat = params.get(CHAT_PARAM);
  const projectId = matchPath({ path: "/projects/:projectId", end: false }, pathname)?.params.projectId;
  useEffect(() => {
    if (!chat || !projectId) return;
    const agent = useAgent.getState();
    agent.selectChat(projectId, chat);
    void agent.loadChats(projectId);
    useShell.getState().setAssistant(true, true);
  }, [chat, projectId]);
  return null;
}
