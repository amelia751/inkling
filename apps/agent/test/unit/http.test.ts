import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/protocol.ts";
import { ENV_TOOLS, TOKEN, harness, snapshot } from "./harness.ts";

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const PATCH = [{ op: "add", path: "/labels/0/classes/-", value: { id: "mitosis" } }];

const FIXTURE = {
  scripts: [
    {
      when: "add a class",
      turns: [
        { text: "Let me look.", toolCalls: [{ name: "get_environment" }] },
        { toolCalls: [{ name: "patch_environment", arguments: { patch: PATCH, summary: "Add a mitosis class" } }] },
        { text: "Added a mitosis class." },
      ],
    },
    { when: "run beats", turns: [{ toolCalls: [{ name: "run_command", arguments: { id: "inkling.timeseries.commands.detectBeats" } }] }, { text: "Command finished." }] },
    { when: "overview", turns: [{ toolCalls: [{ name: "dataset_overview" }, { name: "run_validation" }] }, { text: "Two items, one pending AI suggestion." }] },
    { when: "other project", turns: [{ toolCalls: [{ name: "list_items", arguments: { filter: "all", projectId: "someone-else" } }] }, { text: "ok" }] },
    { when: "cards", turns: [{ toolCalls: [{ name: "show_items", arguments: { title: "Todo", itemIds: ["b.jpeg"] } }] }, { text: "Here they are." }] },
    { when: "many tools", turns: [{ toolCalls: [{ name: "dataset_overview" }, { name: "run_validation" }, { name: "dataset_overview" }] }, { text: "done" }] },
    { when: "wait", turns: [{ toolCalls: [{ name: "get_environment" }] }, { text: "never" }] },
  ],
};

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const text = (events: AgentEvent[]) => events.map((e) => (e.type === "text" ? e.delta : "")).join("");

async function session(hh: H, extra: Record<string, unknown> = {}) {
  const res = await hh.json("POST", "/v1/sessions", { projectId: "demo", profile: "environment-designer", clientTools: ENV_TOOLS, ...extra });
  expect(res.status).toBe(201);
  return res.body.sessionId as string;
}

async function send(hh: H, sessionId: string, body: Record<string, unknown>) {
  const res = await hh.json("POST", `/v1/sessions/${sessionId}/messages`, body);
  expect(res.status).toBe(202);
  return res.body.runId as string;
}

describe("HTTP API", () => {
  it("health is open; everything else needs the service token", async () => {
    h = await harness(FIXTURE);
    expect((await h.app.request("/health/live")).status).toBe(200);
    expect((await h.app.request("/v1/status")).status).toBe(401);
    expect((await h.app.request("/v1/status", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await h.app.request("/v1/status", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await ok.json()).toMatchObject({ configured: true, provider: "scripted", sandbox: "off", profiles: ["assistant", "environment-designer"] });
  });

  it("validates bodies and rejects client tools outside the profile allowlist", async () => {
    h = await harness(FIXTURE);
    expect((await h.json("POST", "/v1/sessions", { projectId: "../etc" })).status).toBe(400);
    const bad = await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: [{ name: "patch_environment", description: "x", input_schema: {} }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/not allowed/);
    const arbitrary = await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "environment-designer", clientTools: [{ name: "exec_shell", description: "x", input_schema: {} }] });
    expect(arbitrary.status).toBe(400);
    expect((await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "coder" })).status).toBe(409);
  });

  it("client-tool round trip: request on the feed, browser POSTs the result, run completes", async () => {
    h = await harness(FIXTURE);
    const sid = await session(h);
    const runId = await send(h, sid, { text: "Please add a class", context: "<environment>{}</environment>" });
    const answered: string[] = [];
    const events = await h.drive(runId, async (e) => {
      if (e.type !== "client-tool") return;
      answered.push(e.name);
      const output = e.name === "get_environment" ? { ok: true, source: { labels: [] } } : { ok: true, summary: { labels: ["mitosis"] } };
      const r = await h!.json("POST", `/v1/runs/${runId}/client-tools/${e.callId}`, { ok: true, output });
      expect(r.status).toBe(200);
      // Answering twice is a conflict, never a second resolution.
      expect((await h!.json("POST", `/v1/runs/${runId}/client-tools/${e.callId}`, { ok: true, output })).status).toBe(409);
    });
    expect(answered).toEqual(["get_environment", "patch_environment"]);
    expect(text(events)).toContain("Added a mitosis class.");
    const patchCall = events.find((e) => e.type === "tool-call" && e.name === "patch_environment");
    expect(patchCall).toMatchObject({ title: "Editing environment" });
    expect(events.filter((e) => e.type === "tool-result").every((e) => e.type === "tool-result" && e.ok)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    // seq is monotonic from 1 and every event carries the run id.
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.runId === runId)).toBe(true);
    // Usage is reported with a cost field.
    expect(events.some((e) => e.type === "usage" && typeof e.costUsd === "number")).toBe(true);
  });

  it("replays events after a seq (and via Last-Event-ID)", async () => {
    h = await harness(FIXTURE);
    const sid = await session(h);
    const runId = await send(h, sid, { text: "overview please", snapshot: snapshot() });
    const all = await h.drive(runId);
    const tail = await h.drive(runId, () => {}, 3);
    expect(tail[0]!.seq).toBe(4);
    expect(tail.map((e) => e.seq)).toEqual(all.slice(3).map((e) => e.seq));
    const res = await h.call("GET", `/v1/runs/${runId}/events`, undefined, { "last-event-id": String(all.length - 1) });
    const body = await res.text();
    expect(body).toContain(`"type":"done"`);
    expect(body).not.toContain(`"seq":1,`);
  });

  it("dataset tools read the shared snapshot", async () => {
    h = await harness(FIXTURE);
    const sid = await session(h);
    const runId = await send(h, sid, { text: "overview please", snapshot: snapshot() });
    const events = await h.drive(runId);
    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool-result" }> => e.type === "tool-result");
    expect(results.map((r) => [r.ok, r.summary])).toEqual([
      [true, "2 items · 1 annotation"],
      [true, "3 issues"],
    ]);
  });

  it("a projectId in tool arguments that isn't the session's is rejected", async () => {
    h = await harness(FIXTURE);
    const sid = await session(h);
    expect((await h.json("POST", `/v1/sessions/${sid}/messages`, { text: "x", snapshot: snapshot("other") })).status).toBe(400);
    const runId = await send(h, sid, { text: "other project", snapshot: snapshot() });
    const events = await h.drive(runId);
    const result = events.find((e) => e.type === "tool-result");
    expect(result).toMatchObject({ ok: false });
    expect((result as any).summary).toMatch(/scoped to project "demo"/);
  });

  it("card tools return at once; the panel gets the request to render", async () => {
    h = await harness(FIXTURE);
    const sid = await session(h);
    const runId = await send(h, sid, { text: "cards", snapshot: snapshot() });
    const events = await h.drive(runId);
    expect(events.find((e) => e.type === "client-tool")).toMatchObject({ name: "show_items", input: { title: "Todo", itemIds: ["b.jpeg"] } });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
  });

  it("approval: run_command waits for the expert; approve runs it, reject blocks it", async () => {
    h = await harness(FIXTURE);
    const sid = await session(h);
    for (const decision of ["approve", "reject"] as const) {
      const runId = await send(h, sid, { text: "run beats" });
      let ran = false;
      const events = await h.drive(runId, async (e) => {
        if (e.type === "approval") {
          expect(e.toolName).toBe("run_command");
          expect(e.summary).toMatch(/detectBeats/);
          expect((await h!.json("POST", `/v1/approvals/${e.approvalId}`, { decision })).status).toBe(200);
          expect((await h!.json("POST", `/v1/approvals/${e.approvalId}`, { decision })).status).toBe(404);
        }
        if (e.type === "client-tool") {
          ran = true;
          await h!.json("POST", `/v1/runs/${runId}/client-tools/${e.callId}`, { ok: true, output: { handled: true } });
        }
      });
      expect(types(events)).toContain("approval");
      expect(events.some((e) => e.type === "run-status" && e.status === "awaiting_approval")).toBe(true);
      expect(events.find((e) => e.type === "approval-resolved")).toMatchObject({ decision });
      expect(ran).toBe(decision === "approve");
      expect(events.find((e) => e.type === "tool-result")).toMatchObject({ ok: decision === "approve" });
      expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    }
  });

  it("cancel rejects a pending client tool and ends the run as cancelled", async () => {
    h = await harness(FIXTURE);
    const sid = await session(h);
    const runId = await send(h, sid, { text: "wait for it" });
    const events = await h.drive(runId, async (e) => {
      if (e.type === "client-tool") expect((await h!.json("POST", `/v1/runs/${runId}/cancel`)).status).toBe(200);
    });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
    expect(h.sessions.findRun(runId).ctx.bridge.size).toBe(0);
    // The session accepts a new message afterwards.
    const next = await send(h, sid, { text: "overview", snapshot: snapshot() });
    expect((await h.drive(next)).at(-1)).toMatchObject({ status: "completed" });
  });

  it("client tools time out instead of hanging the run", async () => {
    h = await harness(FIXTURE, { AGENT_CLIENT_TOOL_TIMEOUT_S: "1" });
    const sid = await session(h);
    const events = await h.drive(await send(h, sid, { text: "wait" }));
    expect(events.find((e) => e.type === "tool-result")).toMatchObject({ ok: false });
    expect((events.find((e) => e.type === "tool-result") as any).summary).toMatch(/no response from the Studio/);
  });

  it("the tool-call budget denies calls past the limit", async () => {
    h = await harness(FIXTURE, { AGENT_MAX_TOOL_CALLS: "2" });
    const sid = await session(h);
    const events = await h.drive(await send(h, sid, { text: "many tools", snapshot: snapshot() }));
    // Parallel calls finish in any order; the policy sees them in call order.
    const order = events.filter((e) => e.type === "tool-call").map((e) => (e as Extract<AgentEvent, { type: "tool-call" }>).id);
    const results = events
      .filter((e): e is Extract<AgentEvent, { type: "tool-result" }> => e.type === "tool-result")
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2]!.summary).toMatch(/budget/);
  });

  it("concurrent runs beyond the limit queue, then run", async () => {
    h = await harness(FIXTURE, { AGENT_MAX_CONCURRENT_RUNS: "1" });
    const a = await session(h);
    const b = await session(h);
    const runA = await send(h, a, { text: "wait" });
    const runB = await send(h, b, { text: "overview", snapshot: snapshot() });
    expect(h.sessions.findRun(runB).run.status).toBe("queued");
    await h.drive(runA, async (e) => {
      if (e.type === "client-tool") await h!.json("POST", `/v1/runs/${runA}/client-tools/${e.callId}`, { ok: true, output: {} });
    });
    expect((await h.drive(runB)).at(-1)).toMatchObject({ status: "completed" });
  });

  it("sessions survive a restart: history is rebuilt from JSONL", async () => {
    h = await harness(FIXTURE);
    const sid = await session(h);
    await h.drive(await send(h, sid, { text: "overview", snapshot: snapshot() }));
    const before = h.sessions.findRun([...(await h.sessions.get(sid)).runs.keys()][0]!).ctx.piSession.messages.length;
    const { SessionService } = await import("../../src/runtime/sessions.ts");
    const { createLogger } = await import("../../src/log.ts");
    const again = new SessionService({ config: h.config, runtime: h.runtime, log: createLogger("silent") });
    const restored = await again.get(sid);
    expect(restored.piSession.messages.length).toBe(before);
    expect(restored.meta.projectId).toBe("demo");
    again.shutdown();
    expect((await h.json("GET", `/v1/sessions/${sid}`)).body).toMatchObject({ sessionId: sid, projectId: "demo", profile: "environment-designer" });
    expect((await h.call("DELETE", `/v1/sessions/${sid}`)).status).toBe(204);
    expect((await h.json("GET", `/v1/sessions/${sid}`)).status).toBe(404);
  });
});
