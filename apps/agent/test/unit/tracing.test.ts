import { defineTool } from "@earendil-works/pi-coding-agent";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Type } from "typebox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ENV_TOOLS, harness } from "./harness.ts";

// todo27 W1: one run gives the span tree invoke_agent → chat / execute_tool, the tool span is the
// active context while the tool runs, the trace id lands on the run record and the `start` event,
// and (D3) no prompt, completion, tool argument or tool result reaches any span.

const CANARY = "CANARY-7f3a9c";
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});
afterAll(async () => {
  trace.disable();
  context.disable();
  await provider.shutdown();
});

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  exporter.reset();
});

describe("todo27 W1: agent spans", { timeout: 30_000 }, () => {
  it("one run: invoke_agent with chat and execute_tool children, tool span active in the tool, no content in any span", async () => {
    const seen: { spanId?: string; traceId?: string }[] = [];
    const tool = defineTool({
      name: "lookup_thing",
      label: "Looking up",
      description: "Test tool.",
      parameters: Type.Object({ query: Type.String() }),
      async execute() {
        await new Promise((r) => setTimeout(r, 5));
        const sc = trace.getActiveSpan()?.spanContext();
        seen.push({ spanId: sc?.spanId, traceId: sc?.traceId });
        return { content: [{ type: "text" as const, text: `result for file ${CANARY}-scan.dcm` }], details: {} };
      },
    });
    const fixture = {
      scripts: [{ turns: [{ toolCalls: [{ name: "lookup_thing", arguments: { query: `find ${CANARY}` } }] }, { text: `Done: ${CANARY}.` }] }],
    };
    h = await harness(fixture, {}, [tool]);
    const sid = (await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "environment-designer", clientTools: ENV_TOOLS })).body.sessionId as string;
    const run = await h.json("POST", `/v1/sessions/${sid}/messages`, { text: `please look up ${CANARY}`, context: `<environment>${CANARY}</environment>` });
    expect(run.status).toBe(202);
    const events = await h.drive(run.body.runId);
    for (let i = 0; i < 100 && !exporter.getFinishedSpans().some((s) => s.name.startsWith("invoke_agent")); i++) await new Promise((r) => setTimeout(r, 10));

    const spans = exporter.getFinishedSpans();
    const root = spans.find((s) => s.name === "invoke_agent studio.assistant") as ReadableSpan;
    expect(root).toBeDefined();
    const traceId = root.spanContext().traceId;
    expect(root.attributes).toMatchObject({
      "gen_ai.conversation.id": sid,
      "studio.run.id": run.body.runId,
      "studio.model": "scripted:replay",
      "studio.run.status": "completed",
    });
    const children = spans.filter((s) => s.parentSpanContext?.spanId === root.spanContext().spanId);
    expect(children.map((s) => s.name).sort()).toEqual(["chat replay", "chat replay", "execute_tool lookup_thing"]);
    expect(spans.every((s) => s.spanContext().traceId === traceId)).toBe(true);
    const chat = children.find((s) => s.name.startsWith("chat"))!;
    expect(chat.attributes).toMatchObject({ "gen_ai.operation.name": "chat", "gen_ai.request.model": "replay", "gen_ai.response.finish_reasons": ["toolUse"] });
    expect(typeof chat.attributes["gen_ai.usage.input_tokens"]).toBe("number");
    const toolSpan = children.find((s) => s.name.startsWith("execute_tool"))!;
    expect(toolSpan.attributes).toMatchObject({ "gen_ai.tool.name": "lookup_thing" });
    expect(toolSpan.attributes["gen_ai.tool.call.id"]).toBeTruthy();

    // The tool ran inside its own span (so outgoing traceparent points at it).
    expect(seen).toEqual([{ spanId: toolSpan.spanContext().spanId, traceId }]);

    // G5: the trace id is on the `start` event and on the run record.
    expect(events.find((e) => e.type === "start")).toMatchObject({ traceId });
    expect((await h.sessions.store.getRun(run.body.runId))?.traceId).toBe(traceId);

    // D3: the canary (in the prompt, the context, a tool argument, a tool result, the reply) is nowhere.
    const dump = JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events, status: s.status, links: s.links })));
    expect(dump).not.toContain(CANARY);
    expect(dump).not.toContain("scan.dcm");
  });
});
