import { beforeEach, describe, expect, it, vi } from "vitest";

/** todo22 W4 (D3): chats complete on the server: browser-made parts, notes, profile and the open chat. */
const listChats = vi.fn();
const fetchThread = vi.fn();
const postUiPart = vi.fn();
const updateSession = vi.fn();
const createSession = vi.fn();
const fetchPrefs = vi.fn();
const putPref = vi.fn();
vi.mock("@/studio/lib/agent/client", async (orig) => ({
  ...(await orig<object>()),
  listChats: (...a: unknown[]) => listChats(...a),
  fetchThread: (...a: unknown[]) => fetchThread(...a),
  postUiPart: (...a: unknown[]) => postUiPart(...a),
  updateSession: (...a: unknown[]) => updateSession(...a),
  createSession: (...a: unknown[]) => createSession(...a),
  deleteSession: () => Promise.resolve(),
}));
vi.mock("@/studio/lib/prefs-api", () => ({ fetchPrefs: () => fetchPrefs(), putPref: (...a: unknown[]) => putPref(...a) }));
vi.mock("@/studio/lib/agent/kernel-token", () => ({ kernelToken: () => Promise.resolve("tok") }));
vi.mock("@/studio/lib/agent/session", () => ({ sessionTools: (profile: string) => ({ profile, clientTools: [], catalogPrompt: undefined }) }));

import { activeChatPref, reduce, useAgent, type ChatMessage } from "./agent";

const reply = (id: string, runId?: string): ChatMessage => ({ id, role: "assistant", ...(runId ? { runId } : {}), parts: [{ type: "text", text: "ok" }] });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("todo22 W4 chats complete on the server", () => {
  beforeEach(() => {
    for (const f of [listChats, fetchThread, postUiPart, updateSession, createSession, fetchPrefs, putPref]) f.mockReset();
    postUiPart.mockResolvedValue(undefined);
    updateSession.mockResolvedValue({ session: null });
    putPref.mockResolvedValue(undefined);
    fetchPrefs.mockResolvedValue({});
    useAgent.setState({ threads: {}, sessions: {}, conversations: {}, chats: {}, runs: {}, streaming: {}, notes: {}, lastOpened: {}, unread: {} });
  });

  it("posts cards, boots and card state changes as ui parts, placed by run", () => {
    useAgent.setState({ conversations: { p: { activeSessionId: "ses_a" } }, threads: { ses_a: [reply("m1", "run_1")] } });
    const s = useAgent.getState();
    s.addPart("p", "m1", { type: "boot", id: "boot-1" });
    s.addPart("p", "m1", { type: "card", id: "call-1", card: { kind: "tool-switch", tool: "box", reason: "r" }, state: "open" });
    s.setCardState("p", "m1", "call-1", "applied");
    expect(postUiPart.mock.calls.map((c) => [c[0], c[1].runId, c[1].part.type, c[1].part.state])).toEqual([
      ["ses_a", "run_1", "boot", undefined],
      ["ses_a", "run_1", "card", "open"],
      ["ses_a", "run_1", "card", "applied"],
    ]);
  });

  it("never posts approvals (the service records them) nor parts of a chat that's only local", () => {
    useAgent.setState({ conversations: { p: { activeSessionId: "conv-12345678" } }, threads: { "conv-12345678": [reply("m1")] } });
    useAgent.getState().addPart("p", "m1", { type: "boot", id: "b" });
    useAgent.setState({ conversations: { p: { activeSessionId: "ses_a" } }, threads: { ses_a: [{ ...reply("m1", "run_1"), parts: [{ type: "approval", id: "apr", toolName: "t", summary: "", inputPreview: "", state: "pending", expiresAt: 0 }] }] } });
    useAgent.getState().setPart("p", "m1", "apr", { failed: "x" } as never);
    expect(postUiPart).not.toHaveBeenCalled();
  });

  it("a ui_part another tab posted lands in the streamed message", () => {
    const part = { type: "card", id: "c1", card: { kind: "tool-switch", tool: "x", reason: "y" }, state: "dismissed" };
    const m = reduce(reply("m1", "run_1"), { type: "custom", name: "ui_part", value: { messageId: "m1", part }, seq: 3, runId: "run_1", at: 0 });
    expect(m.parts.at(-1)).toEqual(part);
    expect(reduce(m, { type: "custom", name: "ui_part", value: { messageId: "m1", part: { ...part, state: "applied" } }, seq: 4, runId: "run_1", at: 0 }).parts.filter((p) => p.type === "card")).toHaveLength(1);
  });

  it("notes go to the open chat's session; the list brings notes, last-opened and the remembered chat back", async () => {
    useAgent.setState({ conversations: { p: { activeSessionId: "ses_a" } } });
    useAgent.getState().addNote("p", "(undid)");
    expect(updateSession).toHaveBeenCalledWith("ses_a", { notes: ["(undid)"] });

    useAgent.setState({ conversations: {}, notes: {} });
    fetchPrefs.mockResolvedValue({ [activeChatPref("p")]: "ses_old" });
    listChats.mockResolvedValue({
      sessions: [
        { id: "ses_new", projectId: "p", title: "New", createdAt: 2, updatedAt: 2, profile: "assistant" },
        { id: "ses_old", projectId: "p", title: "Old", createdAt: 1, updatedAt: 1, profile: "environment-designer", notes: ["(undid)"], lastOpenedAt: "2026-11-03T10:00:00.000Z" },
      ],
    });
    fetchThread.mockResolvedValue({ messages: [] });
    await useAgent.getState().loadChats("p");
    const s = useAgent.getState();
    expect(s.conversations.p).toEqual({ activeSessionId: "ses_old" });
    expect(s.notes.p).toEqual(["(undid)"]);
    expect(s.lastOpened.ses_old).toBe("2026-11-03T10:00:00.000Z");
    expect(s.sessions.ses_old).toEqual({ sessionId: "ses_old", profile: "environment-designer" });
  });

  it("opening a chat stamps it opened on the service and remembers it as the project's open chat", async () => {
    fetchThread.mockResolvedValue({ messages: [] });
    useAgent.getState().selectChat("p", "ses_b");
    await flush();
    expect(updateSession).toHaveBeenCalledWith("ses_b", { opened: true });
    expect(putPref).toHaveBeenCalledWith("chat.active:p", "ses_b");
    expect(/^[a-z][a-z0-9:._-]{0,127}$/.test(activeChatPref("my-project-1"))).toBe(true);
  });

  it("keeps only a cache in storage: no notes, no composer profile", () => {
    const opts = (useAgent as unknown as { persist: { getOptions: () => { partialize: (s: unknown) => Record<string, unknown> } } }).persist.getOptions();
    expect(Object.keys(opts.partialize(useAgent.getState())).sort()).toEqual(["chats", "conversations", "lastOpened", "runs", "sessions", "threads"]);
  });
});
