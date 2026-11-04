import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { BootStudioArgs } from "@studio/studio-tools";
import { Value } from "typebox/value";
import { loadScript, scriptedReply } from "../../src/agent/models.ts";
import type { AgentEventBody } from "@studio/agent-protocol";
import { ApprovalBroker } from "../../src/runtime/approvals.ts";
import { EventLog, Projector, redactInput, sanitizeError } from "../../src/runtime/events.ts";
import { Run } from "../../src/runtime/runs.ts";
import { ClientToolBridge, ClientToolError, createClientTools } from "../../src/tools/client.ts";
import { type Budgets, EXPORT_APPROVAL_BYTES, type PolicyState, decide } from "../../src/tools/policy.ts";

const recorded = readFileSync(join(import.meta.dirname, "fixtures/pi-events.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as AgentSessionEvent);

describe("event projection (recorded pi stream)", () => {
  const project = () => {
    const p = new Projector("scripted:replay", new Map([["bash", "Bash"]]));
    return recorded.flatMap((e) => p.project(e));
  };

  it("maps pi events onto the panel contract in order", () => {
    const out = project();
    const kinds = [...new Set(out.map((e) => e.type))];
    expect(kinds).toEqual(["start", "reasoning", "text", "usage", "tool-call", "tool-progress", "tool-result"]);
    expect(out.filter((e) => e.type === "text").map((e) => (e as any).delta).join("")).toBe("Running it.It printed hi.");
    expect(out.find((e) => e.type === "tool-call")).toMatchObject({ name: "bash", title: "$ echo hi" });
    expect(out.find((e) => e.type === "tool-result")).toMatchObject({ ok: true, summary: "hi" });
  });

  it("a refused Studio change reads as a sentence on the tool row, never JSON (todo24 W6)", () => {
    const p = new Projector("scripted:replay");
    const body = JSON.stringify({ error: "The change doesn't validate. Fix each error at its path and try again.", status: 422, errors: [{ path: "/labels/0/control", code: "schema", message: "required" }] });
    p.project({ type: "tool_execution_start", toolCallId: "tc_9", toolName: "boot_studio", args: {} } as unknown as AgentSessionEvent);
    const out = p.project({ type: "tool_execution_end", toolCallId: "tc_9", toolName: "boot_studio", result: { content: [{ type: "text", text: body }] }, isError: true } as unknown as AgentSessionEvent);
    expect(out.find((e) => e.type === "tool-result")).toMatchObject({ ok: false, summary: "Label set needed a fix" });
  });

  it("streams boot_studio arguments as the start / args / end triple (string fragments), and nothing else", () => {
    const p = new Projector("scripted:replay");
    const call = (name: string, id: string) => ({ type: "toolCall", id, name, arguments: {} });
    const upd = (a: any) => p.project({ type: "message_update", assistantMessageEvent: a } as unknown as AgentSessionEvent);
    const boot = { content: [{ type: "text", text: "" }, call("boot_studio", "tc_1")] };
    const bash = { content: [call("bash", "tc_2")] };
    const out = [
      ...upd({ type: "toolcall_start", contentIndex: 0, partial: bash }),
      ...upd({ type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}', partial: bash }),
      ...upd({ type: "toolcall_end", contentIndex: 0, toolCall: bash.content[0], partial: bash }),
      ...upd({ type: "toolcall_start", contentIndex: 1, partial: boot }),
      ...upd({ type: "toolcall_delta", contentIndex: 1, delta: '{"preset":"pre', partial: boot }),
      ...upd({ type: "toolcall_delta", contentIndex: 1, delta: 'set:image-2d"}', partial: boot }),
      ...upd({ type: "toolcall_end", contentIndex: 1, toolCall: boot.content[1], partial: boot }),
    ];
    expect(out).toEqual([
      { type: "tool-call-start", id: "tc_1", name: "boot_studio" },
      { type: "tool-call-args", id: "tc_1", delta: '{"preset":"pre' },
      { type: "tool-call-args", id: "tc_1", delta: 'set:image-2d"}' },
      { type: "tool-call-end", id: "tc_1" },
    ]);
    // A provider that names the call only at its first delta still gets the triple.
    const late = { content: [{ type: "toolCall", id: "tc_3", arguments: {} }] as any[] };
    const p2 = new Projector("scripted:replay");
    const upd2 = (a: any) => p2.project({ type: "message_update", assistantMessageEvent: a } as unknown as AgentSessionEvent);
    expect(upd2({ type: "toolcall_start", contentIndex: 0, partial: late })).toEqual([]);
    late.content[0].name = "boot_studio";
    expect(upd2({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: late }).map((e) => e.type)).toEqual(["tool-call-start", "tool-call-args"]);
  });

  it("never projects credential-shaped tool arguments", () => {
    const result = project().find((e) => e.type === "tool-result") as Extract<AgentEventBody, { type: "tool-result" }>;
    expect(JSON.stringify(result.input)).not.toContain("sk-live");
    expect(result.input).toEqual({ command: "echo hi", env: "[redacted]" });
    expect(redactInput({ command: "OPENAI_API_KEY=sk-abcdefghijkl python x.py" })).toEqual({ command: "OPENAI_API_KEY=[redacted] python x.py" });
    expect(redactInput({ apiKey: "x", nested: { Authorization: "Bearer y" }, ok: "z" })).toEqual({ apiKey: "[redacted]", nested: { Authorization: "[redacted]" }, ok: "z" });
    expect(sanitizeError("401 from https://x with Bearer abc.def and sk-proj-AAAAAAAAAAAA, DAYTONA_API_KEY=dtn_123")).toBe(
      "401 from https://x with Bearer [redacted] and [redacted], DAYTONA_API_KEY=[redacted]",
    );
  });

  it("the event log numbers events from 1 and replays after a seq", () => {
    const log = new EventLog("run_x");
    for (let i = 0; i < 5; i++) log.push({ type: "text", delta: String(i) });
    expect(log.after(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(log.after(3).map((e) => (e as any).delta)).toEqual(["3", "4"]);
    expect(log.oldestSeq).toBe(1);
    log.push({ type: "done", status: "completed" });
    expect(log.closed).toBe(true);
  });

  it("the replay buffer is bounded (last 2,000 events)", () => {
    const log = new EventLog("run_y");
    for (let i = 0; i < 2100; i++) log.push({ type: "status", text: "x" });
    expect(log.after(0)).toHaveLength(2000);
    expect(log.oldestSeq).toBe(101);
  });

  it("run states move forward only; terminal states are final", () => {
    const run = new Run("ses_1");
    expect(run.transition("completed")).toBe(false);
    expect(run.transition("running")).toBe(true);
    expect(run.transition("awaiting_approval")).toBe(true);
    expect(run.transition("running")).toBe(true);
    expect(run.transition("running")).toBe(false);
    expect(run.transition("cancelled")).toBe(true);
    expect(run.transition("completed")).toBe(false);
    expect(run.events.after(0).at(-1)).toMatchObject({ type: "done", status: "cancelled" });
  });
});

describe("client-tool bridge", () => {
  const emitted: unknown[] = [];
  const bridge = () => new ClientToolBridge({ timeoutS: 0.2, emit: (r) => emitted.push(r) });

  it("request → post → resolve, once", async () => {
    const b = bridge();
    const p = b.request("c1", "get_environment", { a: 1 });
    expect(emitted.at(-1)).toEqual({ callId: "c1", name: "get_environment", input: { a: 1 } });
    expect(b.answer("c1", { ok: true, output: { x: 1 } })).toBe(true);
    expect(b.answer("c1", { ok: true, output: {} })).toBe(false);
    await expect(p).resolves.toEqual({ ok: true, output: { x: 1 } });
    expect(b.size).toBe(0);
  });

  it("times out and cancels", async () => {
    const b = bridge();
    await expect(b.request("c2", "get_environment", {})).rejects.toThrow(/no response from the Studio/);
    const ac = new AbortController();
    const p = b.request("c3", "patch_environment", {}, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(ClientToolError);
    const q = b.request("c4", "patch_environment", {});
    b.cancelAll("run ended");
    await expect(q).rejects.toThrow("run ended");
  });

  it("only allowlisted, well-formed, unique names are registered", () => {
    const b = bridge();
    const spec = (name: string) => ({ name, description: "d", input_schema: { type: "object", properties: {} } });
    expect(() => createClientTools([spec("patch_environment")], ["show_items"], b)).toThrow(/not allowed/);
    expect(() => createClientTools([spec("Bad Name")], ["Bad Name"], b)).toThrow(/not allowed/);
    expect(() => createClientTools([spec("show_items"), spec("show_items")], ["show_items"], b)).toThrow(/duplicate/);
    expect(createClientTools([spec("show_items")], ["show_items"], b).map((t) => t.name)).toEqual(["show_items"]);
  });

  it("a failed browser result becomes a tool error the model sees", async () => {
    const b = bridge();
    const [tool] = createClientTools([{ name: "patch_environment", description: "d", input_schema: { type: "object", properties: {} } }], ["patch_environment"], b);
    const p = tool!.execute("c5", {}, undefined, undefined, {} as never);
    b.answer("c5", { ok: false, output: { errors: [{ path: "/tools/0", message: "unknown tool" }] } });
    await expect(p).rejects.toThrow(/unknown tool/);
  });
});

describe("approvals", () => {
  it("decide resolves once; expiry and cancellation reject", async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const broker = new ApprovalBroker({ expiresS: 10, emit: (r) => seen.push(r.approvalId), onResolved: (_id, d) => seen.push(d.decision) });
      const a = broker.request({ toolCallId: "t", toolName: "run_command", summary: "s", inputPreview: "{}" });
      expect(broker.decide(seen[0]!, { decision: "approve" })).toBe(true);
      expect(broker.decide(seen[0]!, { decision: "reject" })).toBe(false);
      await expect(a).resolves.toMatchObject({ decision: "approve" });
      const b = broker.request({ toolCallId: "t2", toolName: "bash", summary: "s", inputPreview: "{}" });
      vi.advanceTimersByTime(10_001);
      await expect(b).resolves.toMatchObject({ decision: "reject", note: "approval expired" });
      const ac = new AbortController();
      const c = broker.request({ toolCallId: "t3", toolName: "bash", summary: "s", inputPreview: "{}" }, ac.signal);
      ac.abort();
      await expect(c).resolves.toMatchObject({ decision: "reject" });
      expect(broker.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("policy (agent.md §10.1)", () => {
  const budgets: Budgets = { maxToolCalls: 80, maxRunSeconds: 900, maxSpendUsd: 2 };
  const now = 1_000_000;
  const state = (s: Partial<PolicyState> = {}): PolicyState => ({ toolCalls: 0, startedAt: now, spendUsd: 0, restricted: false, egressContained: false, userText: "", ...s });
  const d = (toolName: string, input: Record<string, unknown> = {}, s?: Partial<PolicyState>, bytes?: number) =>
    decide({ toolName, input }, state(s), budgets, { bytes }, now).kind;

  it("reads and environment edits are allowed", () => {
    for (const t of ["dataset_overview", "list_items", "get_environment", "patch_environment", "list_capabilities", "inspect_plugin", "read", "ls", "show_items"]) expect(d(t)).toBe("allow");
  });
  it("plain bash and python are allowed; network-ish ones ask unless egress is contained", () => {
    expect(d("bash", { command: "python3 a.py | head" })).toBe("allow");
    expect(d("run_python", { code: "import numpy as np\nprint(np.ones(3))" })).toBe("allow");
    for (const cmd of ["curl https://x", "wget x", "pip install foo", "npm i left-pad", "uv pip install x"]) expect(d("bash", { command: cmd })).toBe("ask");
    expect(d("run_python", { code: "import requests" })).toBe("ask");
    expect(d("bash", { command: "pip install foo" }, { egressContained: true })).toBe("allow");
    expect(d("bash", { command: "pip install foo" }, { egressContained: true, restricted: true })).toBe("ask");
  });
  it("restricted uploads, big exports and Studio commands ask", () => {
    // todo10 Phase 7: sample bytes never go into a sandbox, restricted or not.
    expect(d("upload_dataset_sample", {}, { restricted: false })).toBe("deny");
    expect(d("bash", { command: "curl http://web/seed/demo/a.dcm -o a.dcm" }, { restricted: false })).toBe("deny");
    expect(d("verify_on_sample", { sample: "a", entrypoint: "m:f" }, { restricted: true })).toBe("allow");
    expect(d("export_artifact", { path: "a" }, {}, EXPORT_APPROVAL_BYTES)).toBe("allow");
    expect(d("export_artifact", { path: "a" }, {}, EXPORT_APPROVAL_BYTES + 1)).toBe("ask");
    expect(d("run_command", { id: "x" })).toBe("ask");
  });
  it("everything is denied once a budget is exhausted", () => {
    expect(d("dataset_overview", {}, { toolCalls: 80 })).toBe("deny");
    expect(d("dataset_overview", {}, { spendUsd: 2 })).toBe("deny");
    expect(d("dataset_overview", {}, { startedAt: now - 900_000 })).toBe("deny");
  });
});

describe("scripted model", () => {
  const fixture = {
    scripts: [
      { when: "^hello", turns: [{ text: "one", toolCalls: [{ name: "t" }] }, { text: "two" }] },
      { turns: [{ text: "fallback" }] },
    ],
  };
  const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 0 });
  const assistant = { role: "assistant" as const, content: [], timestamp: 0 } as never;

  it("picks the script by the latest user message and the turn by assistant messages since", () => {
    expect(scriptedReply(fixture, [user("hello there")]).content).toMatchObject([{ type: "text", text: "one" }, { type: "toolCall", name: "t" }]);
    expect(scriptedReply(fixture, [user("hello there"), assistant]).content).toMatchObject([{ type: "text", text: "two" }]);
    expect(scriptedReply(fixture, [user("hello"), assistant, user("something else")]).content).toMatchObject([{ text: "fallback" }]);
    expect(scriptedReply(fixture, [user("hello"), assistant, assistant]).content[0]).toMatchObject({ text: expect.stringMatching(/nothing more/) });
  });

  it("fills {{when.N}} from the script's capture groups (todo29 W5: the drop id)", () => {
    const f = { scripts: [{ when: '<drop id="(drp-[a-z0-9]+)"', turns: [{ toolCalls: [{ name: "boot_studio", arguments: { dropId: "{{when.1}}", name: "Images" } }] }] }] };
    expect(scriptedReply(f, [user('<drop id="drp-abc12345">\n</drop>\n\nMake me a Studio')]).content).toMatchObject([
      { type: "toolCall", name: "boot_studio", arguments: { dropId: "drp-abc12345", name: "Images" } },
    ]);
  });

  it("the journey fixture's drop turn boots a Studio on the drop (todo29 W5, J1)", () => {
    const f = loadScript(fileURLToPath(new URL("../../../../tests/e2e/fixtures/journey-script.json", import.meta.url)));
    const msg = scriptedReply(f, [user('<drop id="drp-0123456789abcdef">\nThe user dropped files.\n</drop>\n\nMake me a Studio')]);
    const call = (msg.content as { type: string; name?: string; arguments?: unknown }[]).find((c) => c.type === "toolCall");
    expect(call).toMatchObject({ name: "boot_studio", arguments: { dropId: "drp-0123456789abcdef" } });
    expect(Value.Check(BootStudioArgs, call!.arguments)).toBe(true);
  });
});
