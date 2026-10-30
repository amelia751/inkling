import { describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../../src/runtime/approvals.ts";
import { EventLog, Projector, redactInput, sanitizeError } from "../../src/runtime/events.ts";
import { Run } from "../../src/runtime/runs.ts";
import { ClientToolBridge, ClientToolError, createClientTools } from "../../src/tools/client.ts";
import { decide } from "../../src/tools/policy.ts";

describe("Projector", () => {
  it("maps a pi event stream onto the panel contract", () => {
    const p = new Projector("openai:m");
    const ev = (e: any) => p.project(e);
    expect(ev({ type: "agent_start" })).toEqual([{ type: "start", model: "openai:m" }]);
    expect(ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } })).toEqual([{ type: "text", delta: "Hi" }]);
    expect(ev({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hm" } })).toEqual([{ type: "reasoning", delta: "hm" }]);
    expect(ev({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{" } })).toEqual([]);
    expect(ev({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls -la\nmore", api_key: "x" } })).toEqual([
      { type: "tool-call", id: "t1", name: "bash", title: "$ ls -la" },
    ]);
    expect(ev({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "ok" }] } })).toEqual([
      { type: "tool-result", id: "t1", ok: true, summary: "ok", input: { command: "ls -la\nmore", api_key: "[redacted]" } },
    ]);
    const usage = ev({
      type: "message_end",
      message: { role: "assistant", stopReason: "stop", usage: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5, cost: { total: 0.25 } } },
    });
    expect(usage).toEqual([{ type: "usage", inputTokens: 100, outputTokens: 5, costUsd: 0.25 }]);
    expect(p.spendUsd).toBe(0.25);
    expect(ev({ type: "message_end", message: { role: "user" } })).toEqual([]);
  });

  it("surfaces card details and provider errors (sanitized)", () => {
    const p = new Projector("m");
    p.project({ type: "tool_execution_start", toolCallId: "c", toolName: "show_items", args: {} } as any);
    const [r] = p.project({ type: "tool_execution_end", toolCallId: "c", toolName: "show_items", isError: false, result: { content: [], details: { card: { kind: "items" } } } } as any);
    expect(r).toMatchObject({ card: { kind: "items" } });
    const [, err] = p.project({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "bad key sk-abcdefghijklmnop", usage: { input: 0, output: 0, cost: { total: 0 } } } } as any);
    expect(err).toEqual({ type: "error", message: "bad key [redacted]" });
  });

  it("throttles tool progress", () => {
    const p = new Projector("m");
    const u = { type: "tool_execution_update", toolCallId: "t", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "1" }] } } as any;
    expect(p.project(u)).toHaveLength(1);
    expect(p.project(u)).toHaveLength(0);
  });
});

describe("EventLog", () => {
  it("assigns monotonic seq and replays after a cursor", () => {
    const log = new EventLog("run_1");
    const seen: number[] = [];
    log.subscribe((e) => seen.push(e.seq));
    log.push({ type: "text", delta: "a" });
    log.push({ type: "text", delta: "b" });
    log.push({ type: "done", status: "completed" });
    expect(seen).toEqual([1, 2, 3]);
    expect(log.after(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(log.closed).toBe(true);
  });
});

describe("Run", () => {
  it("transitions are monotonic and idempotent, terminal states emit done once", () => {
    const r = new Run("s");
    expect(r.transition("running")).toBe(true);
    expect(r.transition("awaiting_approval")).toBe(true);
    expect(r.transition("running")).toBe(true);
    expect(r.transition("completed")).toBe(true);
    expect(r.transition("completed")).toBe(false);
    expect(r.transition("running")).toBe(false);
    expect(r.events.after(0).filter((e) => e.type === "done")).toHaveLength(1);
  });
});

describe("policy", () => {
  const budgets = { maxToolCalls: 3, maxRunSeconds: 60, maxSpendUsd: 1 };
  const state = { toolCalls: 0, startedAt: 1_000_000, spendUsd: 0, restricted: false, egressContained: false };
  const d = (toolName: string, input: Record<string, unknown>, s = {}) => decide({ toolName, input }, { ...state, ...s }, budgets, 1_000_000);

  it("allows reads and plain commands", () => {
    expect(d("read", { path: "a" })).toEqual({ kind: "allow" });
    expect(d("bash", { command: "python3 x.py" })).toEqual({ kind: "allow" });
    expect(d("patch_environment", {})).toEqual({ kind: "allow" });
  });

  it("asks before network installs unless egress is contained", () => {
    expect(d("bash", { command: "pip install torch" }).kind).toBe("ask");
    expect(d("bash", { command: "curl https://x" }).kind).toBe("ask");
    expect(d("bash", { command: "pip install torch" }, { egressContained: true }).kind).toBe("allow");
    expect(d("bash", { command: "pip install torch" }, { egressContained: true, restricted: true }).kind).toBe("ask");
    expect(d("run_python", { code: "import requests" }).kind).toBe("ask");
    expect(d("upload_dataset_sample", {}, { restricted: true }).kind).toBe("ask");
  });

  it("denies once any budget is exhausted", () => {
    expect(d("read", {}, { toolCalls: 3 }).kind).toBe("deny");
    expect(d("read", {}, { spendUsd: 1 }).kind).toBe("deny");
    expect(decide({ toolName: "read", input: {} }, state, budgets, 1_000_000 + 61_000).kind).toBe("deny");
  });
});

describe("ClientToolBridge", () => {
  it("emits a request and resolves on answer; repeated answers are rejected", async () => {
    const emitted: any[] = [];
    const bridge = new ClientToolBridge({ timeoutS: 5, emit: (r) => emitted.push(r) });
    const p = bridge.request("c1", "get_environment", { a: 1 });
    expect(emitted).toEqual([{ callId: "c1", name: "get_environment", input: { a: 1 } }]);
    expect(bridge.answer("c1", { ok: true, output: { spec: 1 } })).toBe(true);
    expect(bridge.answer("c1", { ok: true, output: {} })).toBe(false);
    await expect(p).resolves.toEqual({ ok: true, output: { spec: 1 } });
  });

  it("times out and cancels", async () => {
    vi.useFakeTimers();
    const bridge = new ClientToolBridge({ timeoutS: 1, emit: () => {} });
    const p = bridge.request("c", "x", {});
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow(/within 1s/);
    vi.useRealTimers();
    const ac = new AbortController();
    const q = bridge.request("d", "x", {}, ac.signal);
    ac.abort();
    await expect(q).rejects.toBeInstanceOf(ClientToolError);
    expect(bridge.size).toBe(0);
  });

  it("only registers allowlisted names", () => {
    const bridge = new ClientToolBridge({ timeoutS: 1, emit: () => {} });
    const spec = (name: string) => ({ name, description: "d", input_schema: { type: "object", properties: {} } });
    expect(createClientTools([spec("get_environment")], ["get_environment"], bridge)).toHaveLength(1);
    expect(() => createClientTools([spec("bash")], ["get_environment"], bridge)).toThrow(/not allowed/);
    expect(() => createClientTools([spec("get_environment"), spec("get_environment")], ["get_environment"], bridge)).toThrow(/duplicate/);
  });

  it("client tools resolve with the browser's output; card tools return immediately", async () => {
    const bridge = new ClientToolBridge({ timeoutS: 5, emit: ({ callId }) => queueMicrotask(() => bridge.answer(callId, { ok: true, output: { n: 2 } })) });
    const spec = (name: string) => ({ name, description: "d", input_schema: { type: "object", properties: {} } });
    const [env, card] = createClientTools([spec("get_environment"), spec("show_items")], ["get_environment", "show_items"], bridge);
    expect((await env!.execute("c1", {}, undefined, undefined, {} as any)).details).toEqual({ n: 2 });
    expect((await card!.execute("c2", { ids: [1] }, undefined, undefined, {} as any)).details).toEqual({ card: { name: "show_items", input: { ids: [1] } } });
  });
});

describe("ApprovalBroker", () => {
  it("resolves decisions, and cancel/expiry count as reject", async () => {
    const reqs: any[] = [];
    const broker = new ApprovalBroker({ expiresS: 60, emit: (r) => reqs.push(r) });
    const p = broker.request({ toolCallId: "t", toolName: "bash", summary: "s", inputPreview: "{}" });
    expect(broker.decide(reqs[0].approvalId, { decision: "approve" })).toBe(true);
    await expect(p).resolves.toEqual({ decision: "approve" });
    const ac = new AbortController();
    const q = broker.request({ toolCallId: "t2", toolName: "bash", summary: "s", inputPreview: "{}" }, ac.signal);
    ac.abort();
    await expect(q).resolves.toMatchObject({ decision: "reject" });
  });
});

describe("redaction", () => {
  it("redacts credential-looking keys and tokens in errors", () => {
    expect(redactInput({ headers: { Authorization: "Bearer x" }, password: "p", ok: 1 })).toEqual({ headers: { Authorization: "[redacted]" }, password: "[redacted]", ok: 1 });
    expect(sanitizeError("Bearer abc.def failed dtn_0123456789abcdef")).toBe("Bearer [redacted] failed [redacted]");
  });
});
