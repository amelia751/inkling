import { afterEach, describe, expect, it } from "vitest";
import type { ThreadMessage } from "@studio/agent-protocol";
import { placeUiParts } from "../../src/runtime/thread.ts";
import type { RunRecord } from "../../src/store/types.ts";
import { harness } from "./harness.ts";

// todo22 W4 (D3): chats complete on the server. Notes, profile and last-opened on the session; the
// parts the browser adds (cards, boots, changes) and the approvals the service asked for replay in
// the thread on any device; a replayed approval is used, never live.

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const KTOKEN = "kernel-session-token-0123456789";

/** A kernel that accepts URL imports (the import tool asks for approval first). */
const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (init?.method === "POST" && url.pathname === "/api/v1/projects/demo/imports/url") return Response.json({ importId: "imp-2", state: "fetching", jobId: "job-1" }, { status: 202 });
  return Response.json({ detail: "no route" }, { status: 404 });
}) as typeof fetch;

describe("chats complete on the server (todo22 W4)", { timeout: 30_000 }, () => {
  it("PATCH sets notes, opened and profile; the list and summary carry them", async () => {
    h = await harness({ scripts: [{ turns: [{ text: "Hi." }] }] });
    const sid = (await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: [] })).body.sessionId as string;
    expect((await h.json("PATCH", `/v1/sessions/${sid}`, {})).status).toBe(400);

    const before = Date.now();
    const r = await h.json("PATCH", `/v1/sessions/${sid}`, { notes: ["The expert undid “Add a panel”."], opened: true });
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ id: sid, notes: ["The expert undid “Add a panel”."] });
    expect(Date.parse(r.body.session.lastOpenedAt)).toBeGreaterThanOrEqual(before - 5);

    const p = await h.json("PATCH", `/v1/sessions/${sid}`, { profile: "environment-designer" });
    expect(p.status).toBe(200);
    expect(p.body.session.profile).toBe("environment-designer");
    expect((await h.json("PATCH", `/v1/sessions/${sid}`, { profile: "home" })).status).toBe(400);

    const listed = (await h.json("GET", "/v1/sessions?projectId=demo")).body.sessions as { id: string; notes: string[]; profile: string; lastOpenedAt: string }[];
    expect(listed.find((s) => s.id === sid)).toMatchObject({ notes: ["The expert undid “Add a panel”."], profile: "environment-designer", lastOpenedAt: r.body.session.lastOpenedAt });

    // The rebuilt session runs with the new profile; clearing notes keeps the rest.
    expect((await h.json("PATCH", `/v1/sessions/${sid}`, { notes: [], title: "Panels" })).body.session).toMatchObject({ notes: [], title: "Panels", titleBy: "person" });
    expect((await h.json("GET", `/v1/sessions/${sid}`)).status).toBe(200);
  });

  it("records browser-made parts and replays them in place; a later post replaces the part", async () => {
    h = await harness({ scripts: [{ turns: [{ text: "Here are the scans." }] }] });
    const sid = (await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: [] })).body.sessionId as string;
    const m = await h.json("POST", `/v1/sessions/${sid}/messages`, { text: "show me the scans" });
    await h.drive(m.body.runId);
    const runId = m.body.runId as string;

    const card = { type: "card", id: "call-1", card: { kind: "items", title: "Scans", itemIds: ["a.jpeg"] }, state: "open" };
    expect((await h.json("POST", `/v1/sessions/${sid}/ui-parts`, { messageId: "local-a1", runId, part: card })).status).toBe(204);
    expect((await h.json("POST", `/v1/sessions/${sid}/ui-parts`, { messageId: "local-a1", runId, part: { type: "boot", id: "boot-1" } })).status).toBe(204);
    expect((await h.json("POST", `/v1/sessions/${sid}/ui-parts`, { messageId: "local-a1", runId, part: { ...card, state: "applied" } })).status).toBe(204);
    // Approvals are the service's own record; unknown parts and other chats' runs are refused.
    expect((await h.json("POST", `/v1/sessions/${sid}/ui-parts`, { messageId: "x", runId, part: { type: "approval", id: "apr-1", state: "approved" } })).status).toBe(400);
    expect((await h.json("POST", `/v1/sessions/${sid}/ui-parts`, { messageId: "x", runId: "run_00000000-0000-0000-0000-000000000000", part: { type: "boot", id: "b" } })).status).toBe(400);

    const thread = (await h.json("GET", `/v1/sessions/${sid}/thread`)).body.messages as ThreadMessage[];
    const reply = thread.find((x) => x.runId === runId)!;
    expect(reply.parts.map((p) => p.type)).toEqual(["text", "card", "boot"]);
    expect(reply.parts[1]).toMatchObject({ type: "card", id: "call-1", state: "applied" });
  });

  it("replays the service's approval decided and used, never live", async () => {
    const fixture = { scripts: [{ turns: [{ toolCalls: [{ name: "import_from_url", arguments: { url: "https://example.com/chest.png" } }] }, { text: "Added." }] }] };
    h = await harness(fixture, {}, [], { fetchImpl });
    const sid = (await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: [], kernelToken: KTOKEN })).body.sessionId as string;
    const m = await h.json("POST", `/v1/sessions/${sid}/messages`, { text: "add this link", kernelToken: KTOKEN });
    let approvalId = "";
    await h.drive(m.body.runId, async (e) => {
      if (e.type !== "approval") return;
      approvalId = e.approvalId;
      expect((await h!.json("POST", `/v1/approvals/${e.approvalId}`, { decision: "approve" })).status).toBe(200);
    });
    expect(approvalId).not.toBe("");
    const thread = (await h.json("GET", `/v1/sessions/${sid}/thread`)).body.messages as ThreadMessage[];
    const reply = thread.find((x) => x.runId === m.body.runId)!;
    const i = reply.parts.findIndex((p) => p.type === "approval");
    expect(reply.parts[i]).toMatchObject({ type: "approval", id: approvalId, state: "approved", used: true, toolName: "import_from_url" });
    // Right after the tool call it guards.
    expect(reply.parts[i - 1]).toMatchObject({ type: "tool", name: "import_from_url" });
    // Single-use: a second answer is refused.
    expect((await h.json("POST", `/v1/approvals/${approvalId}`, { decision: "approve" })).status).toBe(404);
  });

  it("placeUiParts: pending stays live only while its run waits and it hasn't expired", () => {
    const now = 1_000_000;
    const rec = (status: RunRecord["status"]): RunRecord => ({ id: "run_1", sessionId: "ses_x", owner: "local", status, replica: "r", createdAt: 0, updatedAt: 0, heartbeatAt: 0 });
    const approval = { type: "approval", id: "apr-1", toolName: "delete_nodes", summary: "Delete", inputPreview: "{}", state: "pending", expiresAt: now + 60_000 };
    const thread = (): ThreadMessage[] => [{ id: "a", role: "assistant", runId: "run_1", parts: [] }];
    const place = (status: RunRecord["status"], expiresAt = approval.expiresAt) => {
      const t = thread();
      placeUiParts(t, [{ sessionId: "ses_x", runId: "run_1", messageId: "m", partKey: "approval:apr-1", part: { ...approval, expiresAt } }], [rec(status)], now);
      return t[0]!.parts[0];
    };
    expect(place("awaiting_approval")).toMatchObject({ state: "pending" });
    expect(place("awaiting_approval")).not.toHaveProperty("used");
    expect(place("awaiting_approval", now - 1)).toMatchObject({ state: "expired", used: true });
    expect(place("completed")).toMatchObject({ state: "expired", used: true });
    expect(place("interrupted")).toMatchObject({ state: "expired", used: true });
  });
});
