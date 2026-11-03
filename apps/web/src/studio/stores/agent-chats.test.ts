import { beforeEach, describe, expect, it, vi } from "vitest";

/** todo20 D2: chats are agent sessions in a project; todo21 D6: runs are per chat. */
const createSession = vi.fn();
const listChats = vi.fn();
const fetchThread = vi.fn();
const sendMessage = vi.fn();
const followRun = vi.fn();
const renameSession = vi.fn();
const branchSession = vi.fn();
vi.mock("@/studio/lib/agent/client", async (orig) => ({
  ...(await orig<object>()),
  createSession: (...a: unknown[]) => createSession(...a),
  listChats: (...a: unknown[]) => listChats(...a),
  fetchThread: (...a: unknown[]) => fetchThread(...a),
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  followRun: (...a: unknown[]) => followRun(...a),
  renameSession: (...a: unknown[]) => renameSession(...a),
  branchSession: (...a: unknown[]) => branchSession(...a),
  deleteSession: () => Promise.resolve(),
}));
vi.mock("@/studio/lib/agent/kernel-token", () => ({ kernelToken: () => Promise.resolve("tok") }));
vi.mock("@/studio/lib/agent/session", () => ({ sessionTools: (profile: string) => ({ profile, clientTools: [], catalogPrompt: undefined }) }));

import { AgentHttpError } from "@/studio/lib/agent/client";
import { chatTitle, migrateAgent, selectRun, selectStreaming, selectThread, useAgent, type ChatMessage } from "./agent";

let n = 0;
const opts = { profile: "assistant", clientTools: [], restricted: false, context: "" } as never;
const msg = (id: string, text: string): ChatMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

describe("todo20 chats in projects", () => {
  beforeEach(() => {
    n = 0;
    for (const f of [createSession, listChats, fetchThread, sendMessage, followRun, renameSession, branchSession]) f.mockReset();
    createSession.mockImplementation(async (req: { profile: string }) => ({ sessionId: `s${++n}`, profile: req.profile }));
    useAgent.setState({ threads: {}, sessions: {}, conversations: {}, chats: {}, runs: {}, streaming: {}, notes: {}, lastOpened: {}, unread: {} });
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
    await vi.waitFor(() => expect(useAgent.getState().streaming.s1).toBe(true));
    await useAgent.getState().send("B", "second", opts);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const b = useAgent.getState();
    const bThread = b.threads[b.conversations.B!.activeSessionId]!;
    expect(bThread.some((m) => m.error)).toBe(false);
    expect(bThread[0]!.parts[0]).toEqual({ type: "text", text: "second" });
    expect(b.streaming.s1).toBe(true);
    release();
    await a;
    expect(useAgent.getState().streaming.s1).toBeUndefined();
  });

  it("todo21 D4: a send doesn't title the chat; it says New chat until the service names it", async () => {
    sendMessage.mockResolvedValue({ runId: "r", steered: false });
    followRun.mockResolvedValue(undefined);
    await useAgent.getState().send("p", "Segment the liver", opts);
    const chat = useAgent.getState().chats.p![0]!;
    expect(chat.title).toBeNull();
    expect(chatTitle(useAgent.getState(), chat)).toBe("New chat");
  });

  it("todo21 D6: two chats in one project stream at once, each into its own thread", async () => {
    sendMessage.mockImplementation(async (sid: string) => ({ runId: `run-${sid}`, steered: false }));
    const streams: Record<string, { emit: (e: object) => Promise<void>; end: () => void }> = {};
    followRun.mockImplementation((runId: string, _after: number, onEvent: (e: object) => Promise<void>) =>
      new Promise<void>((end) => {
        let seq = 0;
        streams[runId] = { emit: (e) => onEvent({ ...e, runId, seq: ++seq, at: Date.now() }), end };
      }),
    );
    const one = useAgent.getState().send("p", "first", opts);
    await vi.waitFor(() => expect(streams["run-s1"]).toBeDefined());
    await useAgent.getState().newChat("p");
    expect(useAgent.getState().conversations.p!.activeSessionId).toBe("s2");
    const two = useAgent.getState().send("p", "second", opts);
    await vi.waitFor(() => expect(streams["run-s2"]).toBeDefined());
    let s = useAgent.getState();
    expect(s.streaming).toEqual({ s1: true, s2: true });
    expect(Object.keys(s.runs).sort()).toEqual(["s1", "s2"]);
    expect(selectStreaming("p")(s)).toBe(true);
    expect(selectRun("p", "s1")(s)!.runId).toBe("run-s1");
    await streams["run-s1"]!.emit({ type: "text", delta: "one" });
    await streams["run-s2"]!.emit({ type: "text", delta: "two" });
    // Switching chats never stops a run.
    useAgent.getState().selectChat("p", "s1");
    await streams["run-s1"]!.emit({ type: "text", delta: "!" });
    s = useAgent.getState();
    expect(s.threads.s1!.map((m) => m.parts)).toEqual([[{ type: "text", text: "first" }], [{ type: "text", text: "one!" }]]);
    expect(s.threads.s2!.map((m) => m.parts)).toEqual([[{ type: "text", text: "second" }], [{ type: "text", text: "two" }]]);
    expect(s.streaming.s2).toBe(true);
    streams["run-s2"]!.end();
    await two;
    s = useAgent.getState();
    expect(s.streaming).toEqual({ s1: true });
    // It finished while chat 1 was open: chat 2 is unread.
    expect(s.unread.s2).toBe(true);
    streams["run-s1"]!.end();
    await one;
    expect(useAgent.getState().runs).toEqual({});
  });

  it("todo21: session.updated from the run stream retitles the chat", async () => {
    sendMessage.mockResolvedValue({ runId: "r", steered: false });
    followRun.mockImplementation(async (_r: string, _a: number, onEvent: (e: object) => Promise<void>) => {
      await onEvent({ type: "session.updated", session: { id: "s1", projectId: "p", title: "Liver segmentation", titleBy: "auto", createdAt: 1, updatedAt: 1 }, runId: "r", seq: 1, at: 1 });
    });
    await useAgent.getState().send("p", "Segment the liver", opts);
    expect(useAgent.getState().chats.p![0]).toMatchObject({ id: "s1", title: "Liver segmentation", titleBy: "auto" });
  });

  it("todo21: rename PATCHes the title; delete hides the chat and Undo brings it back", async () => {
    renameSession.mockResolvedValue({ session: { id: "s1", projectId: "p", title: "Mine", titleBy: "person", createdAt: 1, updatedAt: 1 } });
    await useAgent.getState().ensureConversation("p");
    await useAgent.getState().renameChat("p", "s1", "  Mine  ");
    expect(renameSession).toHaveBeenCalledWith("s1", "Mine");
    expect(useAgent.getState().chats.p![0]).toMatchObject({ title: "Mine", titleBy: "person" });
    const undo = useAgent.getState().removeChat("p", "s1", 50);
    expect(useAgent.getState().chats.p).toEqual([]);
    undo();
    expect(useAgent.getState().chats.p!.map((c) => c.id)).toEqual(["s1"]);
    expect(useAgent.getState().conversations.p!.activeSessionId).toBe("s1");
  });

  it("todo21 D5: branch posts the message index and opens the new chat under its source", async () => {
    branchSession.mockResolvedValue({ session: { id: "b1", projectId: "p", title: null, createdAt: 3, updatedAt: 3, branchedFrom: { sessionId: "s1", messageIdx: 1 } } });
    await useAgent.getState().ensureConversation("p");
    useAgent.setState((s) => ({ threads: { ...s.threads, s1: [msg("1", "a"), msg("2", "b"), msg("3", "c"), msg("4", "d")] } }));
    const id = await useAgent.getState().branchChat("p", "s1", 1);
    expect(branchSession).toHaveBeenCalledWith("s1", 1);
    const s = useAgent.getState();
    expect(id).toBe("b1");
    expect(s.conversations.p!.activeSessionId).toBe("b1");
    expect(s.threads.b1).toHaveLength(2);
    expect(s.threads.s1).toHaveLength(4);
  });

  it("v4 storage migrates: runs keyed by project are keyed by their chat", () => {
    const out = migrateAgent({ conversations: { p: { activeSessionId: "c1" } }, runs: { p: { projectId: "p", runId: "r", messageId: "m", lastSeq: 3, answered: [] } } }, 4);
    expect(out.runs).toEqual({ c1: { projectId: "p", chatId: "c1", runId: "r", messageId: "m", lastSeq: 3, answered: [] } });
  });

  it("v3 storage migrates: one conversation per project becomes a chat keyed by its id", () => {
    const out = migrateAgent({ threads: { p: [msg("u", "hi")] }, conversations: { p: { id: "conv-1", title: "Hi" } }, sessions: { p: { sessionId: "s", profile: "assistant" } } }, 3);
    expect(out.conversations).toEqual({ p: { activeSessionId: "conv-1" } });
    expect((out.threads as Record<string, unknown[]>)["conv-1"]).toHaveLength(1);
    expect((out.sessions as Record<string, unknown>)["conv-1"]).toEqual({ sessionId: "s", profile: "assistant" });
  });
});

describe("todo22 W4 server thread", () => {
  it("the server's thread is the whole thread: the cache adds nothing", async () => {
    const { mergeThread, SERVER_PARTS } = await import("./agent");
    const server: ChatMessage[] = [{ id: "a", role: "assistant", runId: "r1", parts: [{ type: "text", text: "done" }, { type: "boot", id: "b1" }] }];
    const cached: ChatMessage[] = [{ id: "local", role: "assistant", runId: "r1", parts: [{ type: "text", text: "do" }, { type: "card", id: "c9", card: { kind: "tool-switch", tool: "x", reason: "y" }, state: "open" }] }];
    expect(mergeThread(server, cached)).toBe(server);
    for (const t of ["text", "reasoning", "tool", "drop", "card", "approval", "change", "artifact", "status", "boot"]) expect(SERVER_PARTS.has(t as never)).toBe(true);
  });
});
