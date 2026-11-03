import { afterEach, describe, expect, it } from "vitest";
import { ENV_TOOLS, harness } from "./harness.ts";
import { buildThread, parseUserText, titleFrom } from "../../src/runtime/thread.ts";

// todo20 W3 / D2: chats belong to a project and live on the server.

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const FIXTURE = {
  scripts: [
    { when: "overview", turns: [{ text: "Let me look.", toolCalls: [{ name: "dataset_overview" }] }, { text: "Two items." }] },
    { when: "hello", turns: [{ text: "Hi there." }] },
  ],
};

const BASE = { profile: "environment-designer", clientTools: ENV_TOOLS };

describe("chats (sessions) per project", { timeout: 30_000 }, () => {
  it("lists a project's chats newest first, titled from the first message", async () => {
    h = await harness(FIXTURE);
    const a = await h.json("POST", "/v1/sessions", { projectId: "demo", ...BASE });
    expect(a.status).toBe(201);
    expect(a.body.session).toMatchObject({ id: a.body.sessionId, projectId: "demo", title: null });
    expect(typeof a.body.session.createdAt).toBe("number");
    expect(a.body.session.updatedAt).toBe(a.body.session.createdAt);
    const b = await h.json("POST", "/v1/sessions", { projectId: "demo", ...BASE });
    await h.json("POST", "/v1/sessions", { projectId: "other", ...BASE });

    const long = `hello, please ${"x".repeat(100)}`;
    const run = await h.json("POST", `/v1/sessions/${a.body.sessionId}/messages`, { text: long, context: "<environment>{}</environment>" });
    expect(run.status).toBe(202);
    await h.drive(run.body.runId);

    const list = await h.json("GET", "/v1/sessions?projectId=demo");
    expect(list.status).toBe(200);
    expect(list.body.sessions.map((s: { id: string }) => s.id)).toEqual([a.body.sessionId, b.body.sessionId]);
    const [first, second] = list.body.sessions;
    expect(first.title.length).toBeLessThanOrEqual(60);
    // todo21 D4: the first completed run renames it (scripted model: the heuristic, first clause).
    expect(first).toMatchObject({ title: "Hello", titleBy: "auto" });
    expect(first.updatedAt).toBeGreaterThanOrEqual(first.createdAt);
    expect(second.title).toBeNull();
    expect(Object.keys(first).sort()).toEqual(["branchedFrom", "createdAt", "id", "lastRunAt", "profile", "projectId", "running", "title", "titleBy", "updatedAt"]);
  });

  it("rebuilds the thread from the transcript and the run records", async () => {
    h = await harness(FIXTURE);
    const s = await h.json("POST", "/v1/sessions", { projectId: "demo", ...BASE });
    const sid = s.body.sessionId as string;
    expect((await h.json("GET", `/v1/sessions/${sid}/thread`)).body).toEqual({ sessionId: sid, messages: [] });
    const run = await h.json("POST", `/v1/sessions/${sid}/messages`, { text: "overview", context: "<environment>{}</environment>" });
    await h.drive(run.body.runId);

    const t = await h.json("GET", `/v1/sessions/${sid}/thread`);
    expect(t.status).toBe(200);
    expect(t.body.sessionId).toBe(sid);
    const [user, assistant] = t.body.messages;
    expect(t.body.messages).toHaveLength(2);
    expect(user).toMatchObject({ role: "user", parts: [{ type: "text", text: "overview" }] });
    expect(assistant).toMatchObject({ role: "assistant", runId: run.body.runId, runStatus: "completed" });
    expect(assistant.parts.map((p: { type: string }) => p.type)).toEqual(["text", "tool", "text"]);
    // The harness has no seed API, so the tool fails; it has its result either way.
    expect(assistant.parts[1]).toMatchObject({ type: "tool", name: "dataset_overview", title: "Reading dataset overview", status: "error", summary: "fetch failed" });
    expect(assistant.model).toBe("scripted:replay");
    expect(assistant.parts[2]).toMatchObject({ type: "text", text: "Two items." });
  });

  it("creates a session on first use under the browser's conversation id; others can't take it", async () => {
    h = await harness(FIXTURE);
    const conv = `conv-${crypto.randomUUID()}`;
    // No session yet and no creation fields: still a 404.
    expect((await h.json("POST", `/v1/sessions/${conv}/messages`, { text: "hello" })).status).toBe(404);
    const run = await h.json("POST", `/v1/sessions/${conv}/messages`, { text: "hello", session: { projectId: "demo", ...BASE } });
    expect(run.status).toBe(202);
    await h.drive(run.body.runId);
    const list = await h.json("GET", "/v1/sessions?projectId=demo");
    expect(list.body.sessions).toEqual([expect.objectContaining({ id: conv, projectId: "demo", title: "Hello" })]);
    const t = await h.json("GET", `/v1/sessions/${conv}/thread`);
    expect(t.body.messages.at(-1)).toMatchObject({ role: "assistant", parts: [{ type: "text", text: "Hi there." }] });

    // POST /v1/sessions with the same id is idempotent; another project can't claim it.
    const again = await h.json("POST", "/v1/sessions", { projectId: "demo", sessionId: conv, ...BASE });
    expect(again.status).toBe(201);
    expect(again.body.session).toMatchObject({ id: conv, title: "Hello" });
    expect((await h.json("POST", "/v1/sessions", { projectId: "other", sessionId: conv, ...BASE })).status).toBe(409);
    expect((await h.json("POST", "/v1/sessions", { projectId: "demo", sessionId: "../x", ...BASE })).status).toBe(400);
    expect((await h.json("GET", "/v1/sessions/conv-00000000-nope/thread")).status).toBe(404);
  });
});

describe("thread helpers", () => {
  it("strips the studio context and drop blocks from user text", () => {
    const raw = `<studio_context>\n<environment>{}</environment>\n</studio_context>\n\n<drop id="drp-abc12345">\nThe user dropped files.\n{"a":1}\n</drop>\n\nlabel these`;
    expect(parseUserText(raw)).toEqual({ text: "label these", dropId: "drp-abc12345" });
    expect(parseUserText(`<drop id="drp-x1234567" unavailable="no"/>`)).toEqual({ text: "", dropId: "drp-x1234567" });
  });

  it("titles are one line, at most 60 characters", () => {
    expect(titleFrom("  hi\n there ")).toBe("hi there");
    expect(titleFrom("")).toBeNull();
    expect(titleFrom("a".repeat(80))).toHaveLength(60);
  });

  it("marks tools of a finished run without a result as failed, and interrupted runs", () => {
    const entries = [
      { type: "session" },
      { type: "message", id: "u1", message: { role: "user", content: "go", timestamp: 1000 } },
      { type: "message", id: "a1", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", id: "c1", name: "t", arguments: {} }], timestamp: 1001 } },
    ];
    const runs = [{ id: "run_1", sessionId: "s", owner: "o", status: "interrupted" as const, replica: "r", createdAt: 1000, updatedAt: 0, heartbeatAt: 0 }];
    const [, a] = buildThread(entries, runs, new Map([["t", "Tool"]]));
    expect(a).toMatchObject({ runId: "run_1", runStatus: "failed", model: "p:m", parts: [{ type: "tool", title: "Tool", status: "error" }] });
    expect(a!.error).toMatch(/interrupted/);
  });
});
