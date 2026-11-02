import { beforeEach, describe, expect, it, vi } from "vitest";

/** todo20 D2: chats are agent sessions in a project; runs are per project. */
const createSession = vi.fn();
const listChats = vi.fn();
const fetchThread = vi.fn();
const sendMessage = vi.fn();
const followRun = vi.fn();
vi.mock("@/studio/lib/agent/client", async (orig) => ({
  ...(await orig<object>()),
  createSession: (...a: unknown[]) => createSession(...a),
  listChats: (...a: unknown[]) => listChats(...a),
  fetchThread: (...a: unknown[]) => fetchThread(...a),
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  followRun: (...a: unknown[]) => followRun(...a),
  deleteSession: () => Promise.resolve(),
}));
vi.mock("@/studio/lib/agent/kernel-token", () => ({ kernelToken: () => Promise.resolve("tok") }));
vi.mock("@/studio/lib/agent/session", () => ({ sessionTools: (profile: string) => ({ profile, clientTools: [], catalogPrompt: undefined }) }));

import { AgentHttpError } from "@/studio/lib/agent/client";
import { migrateAgent, selectThread, useAgent, type ChatMessage } from "./agent";

let n = 0;
const opts = { profile: "assistant", clientTools: [], restricted: false, context: "" } as never;
const msg = (id: string, text: string): ChatMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

describe("todo20 chats in projects", () => {
  beforeEach(() => {
    n = 0;
    for (const f of [createSession, listChats, fetchThread, sendMessage, followRun]) f.mockReset();
    createSession.mockImplementation(async (req: { profile: string }) => ({ sessionId: `s${++n}`, profile: req.profile }));
    useAgent.setState({ threads: {}, sessions: {}, conversations: {}, chats: {}, runs: {}, streaming: {}, notes: {}, running: null, active: null });
  });

  it("conversation() is created on the server on first use, then reused", async () => {
    const a = await useAgent.getState().ensureConversation("p");
    expect(a.id).toBe("s1");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0]![0]).toMatchObject({ projectId: "p", profile: "assistant" });
    expect(useAgent.getState().conversation("p").id).toBe("s1");
    expect((await useAgent.getState().ensureConversation("p")).id).toBe("s1");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(useAgent.getState().conversations.p).toEqual({ activeSessionId: "s1" });
  });

  it("two callers at once share one new chat", async () => {
    const [a, b] = await Promise.all([useAgent.getState().ensureConversation("p"), useAgent.getState().ensureConversation("p")]);
    expect(a.id).toBe(b.id);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("the service is down: a local conv- chat, so drops still name one", async () => {
    createSession.mockRejectedValue(new AgentHttpError(502, "down"));
    const a = await useAgent.getState().ensureConversation("p");
    expect(a.id).toMatch(/^conv-/);
  });

  it("newChat keeps the old session listed and opens a new one", async () => {
    await useAgent.getState().ensureConversation("p");
    useAgent.setState((s) => ({ threads: { ...s.threads, s1: [msg("u1", "Count the CTs")] } }));
    await useAgent.getState().newChat("p");
    const s = useAgent.getState();
    expect(s.conversations.p!.activeSessionId).toBe("s2");
    expect(s.chats.p!.map((c) => c.id).sort()).toEqual(["s1", "s2"]);
    expect(s.threads.s1).toHaveLength(1);
    expect(selectThread("p")(s)).toEqual([]);
    useAgent.getState().selectChat("p", "s1");
    expect(selectThread("p")(useAgent.getState())).toHaveLength(1);
  });

  it("the thread cache is keyed by session, and the server's thread replaces it", async () => {
    listChats.mockResolvedValue({ sessions: [{ id: "srv2", projectId: "p", title: "Newer", createdAt: 2, updatedAt: 2 }, { id: "srv1", projectId: "p", title: "Older", createdAt: 1, updatedAt: 1 }] });
    fetchThread.mockResolvedValue({ sessionId: "srv2", messages: [msg("a", "hi"), msg("b", "there")] });
    useAgent.setState({ threads: { srv1: [msg("x", "old cache")] } });
    await useAgent.getState().loadChats("p");
    const s = useAgent.getState();
    expect(s.conversations.p).toEqual({ activeSessionId: "srv2" });
    expect(s.chats.p!.map((c) => c.id)).toEqual(["srv2", "srv1"]);
    expect(s.threads.srv2).toHaveLength(2);
    expect(s.threads.srv1).toEqual([msg("x", "old cache")]);
    expect(fetchThread).toHaveBeenCalledWith("srv2");
  });

  it("the endpoints 404: the local cache carries on", async () => {
    listChats.mockRejectedValue(new AgentHttpError(404, "Not found"));
    useAgent.setState({ conversations: { p: { activeSessionId: "s9" } }, threads: { s9: [msg("x", "cached")] } });
    await useAgent.getState().loadChats("p");
    expect(selectThread("p")(useAgent.getState())).toHaveLength(1);
  });

  it("a run in project A doesn't block a send in project B", async () => {
    sendMessage.mockImplementation(async (sid: string) => ({ runId: `run-${sid}`, steered: false }));
    let release!: () => void;
    followRun.mockImplementation((runId: string) => (runId === "run-s1" ? new Promise<void>((r) => (release = r)) : Promise.resolve()));
    const a = useAgent.getState().send("A", "first", opts);
    await vi.waitFor(() => expect(useAgent.getState().streaming.A).toBe(true));
    await useAgent.getState().send("B", "second", opts);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const b = useAgent.getState();
    const bThread = b.threads[b.conversations.B!.activeSessionId]!;
    expect(bThread.some((m) => m.error)).toBe(false);
    expect(bThread[0]!.parts[0]).toEqual({ type: "text", text: "second" });
    expect(b.streaming.A).toBe(true);
    release();
    await a;
    expect(useAgent.getState().streaming.A).toBeUndefined();
  });

  it("a send titles the chat from its first message", async () => {
    sendMessage.mockResolvedValue({ runId: "r", steered: false });
    followRun.mockResolvedValue(undefined);
    await useAgent.getState().send("p", "Segment the liver", opts);
    expect(useAgent.getState().chats.p![0]!.title).toBe("Segment the liver");
  });

  it("v3 storage migrates: one conversation per project becomes a chat keyed by its id", () => {
    const out = migrateAgent({ threads: { p: [msg("u", "hi")] }, conversations: { p: { id: "conv-1", title: "Hi" } }, sessions: { p: { sessionId: "s", profile: "assistant" } } }, 3);
    expect(out.conversations).toEqual({ p: { activeSessionId: "conv-1" } });
    expect((out.threads as Record<string, unknown[]>)["conv-1"]).toHaveLength(1);
    expect((out.sessions as Record<string, unknown>)["conv-1"]).toEqual({ sessionId: "s", profile: "assistant" });
  });
});

describe("todo20 server thread merge", () => {
  it("keeps the browser's cards and boots on the server's messages", async () => {
    const { mergeThread } = await import("./agent");
    const server: ChatMessage[] = [{ id: "a", role: "assistant", runId: "r1", parts: [{ type: "text", text: "done" }] }];
    const cached: ChatMessage[] = [{ id: "local", role: "assistant", runId: "r1", parts: [{ type: "text", text: "do" }, { type: "boot", id: "b1" }] }];
    expect(mergeThread(server, cached)[0]!.parts).toEqual([{ type: "text", text: "done" }, { type: "boot", id: "b1" }]);
  });
});
