import { afterEach, describe, expect, it } from "vitest";
import { ENV_TOOLS, harness } from "./harness.ts";
import { DEV_KERNEL_SERVICE_TOKEN } from "../../src/config.ts";
import { heuristicTitle } from "../../src/agent/titler.ts";
import { transcriptCut } from "../../src/runtime/thread.ts";

// todo21 W3 (D4, D7) and W4 (D5): chats name themselves, a person can rename them, and any chat
// branches from a message.

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const FIXTURE = {
  scripts: [
    { when: "first", turns: [{ text: "First answer." }] },
    { when: "second", turns: [{ text: "Second answer." }] },
    { when: "third", turns: [{ text: "Third answer." }] },
    { turns: [{ text: "Anything else." }] },
  ],
};
const BASE = { profile: "environment-designer", clientTools: ENV_TOOLS };

/** Records the kernel title calls the service makes (D7). */
function kernel() {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/conversations/")) {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return Response.json({ renamed: true, folder: "x" });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function send(sid: string, text: string) {
  const run = await h!.json("POST", `/v1/sessions/${sid}/messages`, { text, context: "<environment>{}</environment>" });
  expect(run.status).toBe(202);
  return h!.drive(run.body.runId);
}

describe("chat titles", { timeout: 30_000 }, () => {
  it("heuristic: the first clause, at most six words, without filler", () => {
    expect(heuristicTitle("can you look at these chest x-rays and tell me which ones are rotated?")).toBe("Look at these chest x-rays and");
    expect(heuristicTitle("Segment the liver. Then export.")).toBe("Segment the liver");
    expect(heuristicTitle("   ")).toBeNull();
  });

  it("names a chat after its first completed run (scripted: heuristic), emits session.updated, tells the kernel", async () => {
    const k = kernel();
    h = await harness(FIXTURE, {}, [], { fetchImpl: k.fetchImpl });
    const sid = (await h.json("POST", "/v1/sessions", { projectId: "demo", ...BASE })).body.sessionId as string;
    const events = await send(sid, "first, please count the liver scans in this project");
    const updates = events.filter((e) => e.type === "session.updated").flatMap((e) => (e.type === "session.updated" ? [e.session] : []));
    expect(updates[0]).toMatchObject({ id: sid, running: true, titleBy: null });
    expect(updates.some((s) => s.title === "First" && s.titleBy === "auto")).toBe(true);
    expect(updates.at(-1)).toMatchObject({ running: false, titleBy: "auto", title: "First" });
    expect(typeof updates.at(-1)!.lastRunAt).toBe("string");
    // session.updated comes before done.
    expect(events.at(-1)!.type).toBe("done");

    await send(sid, "second question");
    const row = (await h.json("GET", "/v1/sessions?projectId=demo")).body.sessions[0];
    expect(row).toMatchObject({ title: "First", titleBy: "auto", running: false, branchedFrom: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(k.calls).toHaveLength(1);
    expect(k.calls[0]!.url).toContain(`/api/v1/projects/demo/conversations/${sid}/title`);
    expect(k.calls[0]!.auth).toBe(`Bearer ${DEV_KERNEL_SERVICE_TOKEN}`);
    expect(k.calls[0]!.body).toMatchObject({ title: "First" });
  });

  it("PATCH renames (owner only, trimmed, ≤ 80) and a person's title is never replaced", async () => {
    const k = kernel();
    h = await harness(FIXTURE, {}, [], { fetchImpl: k.fetchImpl });
    const sid = (await h.json("POST", "/v1/sessions", { projectId: "demo", ...BASE })).body.sessionId as string;
    expect((await h.json("PATCH", `/v1/sessions/${sid}`, { title: "   " })).status).toBe(400);
    expect((await h.json("PATCH", `/v1/sessions/${sid}`, { title: "x".repeat(81) })).status).toBe(400);
    expect((await h.json("PATCH", `/v1/sessions/ses_00000000-0000-0000-0000-000000000000`, { title: "Nope" })).status).toBe(404);
    const r = await h.json("PATCH", `/v1/sessions/${sid}`, { title: "  Liver   CT review " });
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ id: sid, title: "Liver CT review", titleBy: "person" });

    const events = await send(sid, "first thing to do");
    expect(events.filter((e) => e.type === "session.updated").every((e) => e.type === "session.updated" && e.session.title === "Liver CT review")).toBe(true);
    const row = (await h.json("GET", "/v1/sessions?projectId=demo")).body.sessions[0];
    expect(row).toMatchObject({ title: "Liver CT review", titleBy: "person" });
    await new Promise((r) => setTimeout(r, 20));
    expect(k.calls.map((c) => c.body)).toEqual([{ title: "Liver CT review" }]);
  });
});

describe("branch a chat", { timeout: 30_000 }, () => {
  it("maps message indexes to transcript rows (a turn stays whole)", () => {
    const m = (role: string) => ({ type: "message", message: { role, content: [{ type: "text", text: role }] } });
    const rows = [{ type: "session" }, m("user"), m("assistant"), m("toolResult"), m("assistant"), { type: "custom" }, m("user"), m("assistant")];
    expect(transcriptCut(rows, 0)).toBe(2);
    expect(transcriptCut(rows, 1)).toBe(6);
    expect(transcriptCut(rows, 2)).toBe(7);
    expect(transcriptCut(rows, 3)).toBe(8);
    expect(transcriptCut(rows, 4)).toBeUndefined();
  });

  it("branch at message 2 of 4: the branch has 2, the source keeps 4, and the branch runs on its own", async () => {
    h = await harness(FIXTURE);
    const sid = (await h.json("POST", "/v1/sessions", { projectId: "demo", ...BASE })).body.sessionId as string;
    await send(sid, "first question");
    await send(sid, "second question");
    expect((await h.json("GET", `/v1/sessions/${sid}/thread`)).body.messages).toHaveLength(4);

    expect((await h.json("POST", `/v1/sessions/${sid}/branch`, { messageIdx: 9 })).status).toBe(400);
    const b = await h.json("POST", `/v1/sessions/${sid}/branch`, { messageIdx: 1 });
    expect(b.status).toBe(201);
    const bid = b.body.session.id as string;
    expect(bid).not.toBe(sid);
    expect(b.body.session).toMatchObject({ projectId: "demo", branchedFrom: { sessionId: sid, messageIdx: 1 }, titleBy: null, running: false });

    const bt = (await h.json("GET", `/v1/sessions/${bid}/thread`)).body.messages;
    expect(bt).toHaveLength(2);
    expect(bt[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "first question" }] });
    expect(bt[1].parts).toEqual([{ type: "text", text: "First answer." }]);

    const events = await send(bid, "third question");
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    const after = (await h.json("GET", `/v1/sessions/${bid}/thread`)).body.messages;
    expect(after).toHaveLength(4);
    expect(after[3].parts).toEqual([{ type: "text", text: "Third answer." }]);
    // The branch names itself from its own first exchange.
    const rows = (await h.json("GET", "/v1/sessions?projectId=demo")).body.sessions;
    expect(rows.find((r: { id: string }) => r.id === bid)).toMatchObject({ title: "Third question", titleBy: "auto" });

    const src = (await h.json("GET", `/v1/sessions/${sid}/thread`)).body.messages;
    expect(src).toHaveLength(4);
    expect(src[2].parts).toEqual([{ type: "text", text: "second question" }]);
  });
});
