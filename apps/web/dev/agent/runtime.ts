import type { AgentContext, AgentEvent, ChatTurn } from "../../src/lib/agent/protocol";
import { runTool, toolSpecs, toolTitle } from "./tools";

const MAX_STEPS = 8;

export const agentModel = () => process.env.INKLING_AGENT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-6.1-sol";
export const agentConfigured = () => !!process.env.OPENAI_API_KEY;

function instructions(ctx: AgentContext): string {
  const current = ctx.items.find((i) => i.id === ctx.currentItemId);
  return `You are Inkling AI, an assistant inside a medical-imaging annotation studio. You help domain experts (radiologists, cardiologists, pathologists) who are not ML engineers plan, check and document their annotation work.

What you can and cannot do:
- You see a text snapshot only: dataset metadata, item names, label set and annotation summaries. You never see pixels, signals or video. Never claim to have looked at an image, and never invent coordinates, contours, measurements or diagnoses.
- When asked to suggest a contour, box or label for an image, say plainly that you can't see the image, then use suggest_tool to set up the best tool in this viewer (with the right label active) and explain in one or two sentences how to use it.
- Nothing you do changes annotations. Cards from propose_review, select_annotations and suggest_tool only act if the expert clicks them. Say so when you offer one.
- Use tools for facts instead of guessing. Prefer run_validation for warnings, list_items + show_items for "find…" requests, propose_label_schema for label design, draft_document for documentation.
- Don't provide clinical diagnoses or claim expert or clinical verification. Note uncertainty and licence limits where relevant.

Style: plain language, short. Lead with the answer. Use short paragraphs or bullets, not headings, in chat. Refer to items by name. Don't repeat card contents in prose; one sentence introducing a card is enough.

Current context:
- Dataset: ${ctx.project.title} (${ctx.project.viewer}${ctx.project.task ? `, task: ${ctx.project.task}` : ""})
- Labels: ${ctx.project.labels.join(", ") || "none defined"}
- ${ctx.items.length} items, ${ctx.annotations.length} annotations${ctx.project.restricted ? "; licence restricts redistribution (local development only)" : ""}
- Open in the viewer: ${current ? `${current.name} (${current.group})` : "nothing"}
- Viewer tools: ${ctx.tools.join(", ")}`;
}

type Item = Record<string, unknown> & { type: string };

/** Parse an SSE byte stream into JSON payloads. */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data);
    }
  }
}

/** One agent run: model ⇄ tools until the model answers without calling a tool. */
export async function runAgent(messages: ChatTurn[], ctx: AgentContext, emit: (e: AgentEvent) => void, signal: AbortSignal) {
  const model = agentModel();
  emit({ type: "start", model });
  let input: Item[] = messages.map((m) => ({ type: "message", role: m.role, content: m.content }));
  let inputTokens = 0;
  let outputTokens = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        instructions: instructions(ctx),
        input,
        tools: toolSpecs,
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "low", summary: "auto" },
      }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let message = `Model request failed (${res.status}).`;
      try {
        message = JSON.parse(text).error?.message ?? message;
      } catch {}
      throw new Error(message);
    }

    const output: Item[] = [];
    for await (const ev of sse(res.body)) {
      switch (ev.type) {
        case "response.output_text.delta":
          emit({ type: "text", delta: ev.delta });
          break;
        case "response.reasoning_summary_text.delta":
          emit({ type: "reasoning", delta: ev.delta });
          break;
        case "response.output_item.added":
          if (ev.item?.type === "function_call") emit({ type: "tool-call", id: ev.item.call_id, name: ev.item.name, title: toolTitle(ev.item.name) });
          break;
        case "response.output_item.done":
          output.push(ev.item);
          break;
        case "response.completed":
          inputTokens += ev.response?.usage?.input_tokens ?? 0;
          outputTokens += ev.response?.usage?.output_tokens ?? 0;
          break;
        case "response.failed":
        case "error":
          throw new Error(ev.response?.error?.message ?? ev.message ?? "The model returned an error.");
      }
    }

    const calls = output.filter((i) => i.type === "function_call") as (Item & { call_id: string; name: string; arguments: string })[];
    if (!calls.length) break;
    const results: Item[] = calls.map((call) => {
      const r = runTool(call.name, call.arguments, ctx);
      emit({ type: "tool-result", id: call.call_id, ok: r.ok, summary: r.summary, input: r.input, card: r.card });
      return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(r.output) };
    });
    input = [...input, ...output, ...results];
    if (step === MAX_STEPS - 1) emit({ type: "error", message: "Stopped after too many tool steps. Try a narrower question." });
  }
  emit({ type: "usage", inputTokens, outputTokens });
}
