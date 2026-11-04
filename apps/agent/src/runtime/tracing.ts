import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type Context, type Span, SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { sanitizeError } from "./events.ts";

/**
 * todo27 W1: OpenTelemetry spans for one run, from the same pi session events `events.ts` projects.
 * Uses `@opentelemetry/api` only, so it is a no-op until an SDK is registered (`initTracing`).
 *
 *   invoke_agent studio.assistant      (one per run)
 *   ├─ chat <model>                    (one per assistant message)
 *   ├─ execute_tool <name>             (one per tool call; the active context while the tool runs)
 *   └─ compaction
 *
 * D3: spans carry names, ids, models, token counts, cost, stop reasons, error types and short
 * sanitized provider errors. Never prompts, completions, tool arguments, tool results or file names.
 */
const tracer = () => trace.getTracer("studio.agent");

export interface RunTraceInfo {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  thinking?: string;
  profile?: string;
}

const validTraceId = (id: string) => (/^0+$/.test(id) ? undefined : id);

export class RunTracer {
  readonly span: Span;
  private readonly ctx: Context;
  private chat: Span | undefined;
  private compaction: Span | undefined;
  private readonly tools = new Map<string, Span>();
  private costUsd = 0;
  private readonly usage = { input: 0, output: 0, cached: 0 };
  private ended = false;

  constructor(private readonly info: RunTraceInfo, parent: Context = context.active()) {
    this.span = tracer().startSpan(
      "invoke_agent studio.assistant",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "studio.assistant",
          "gen_ai.conversation.id": info.sessionId,
          "gen_ai.provider.name": info.provider,
          "gen_ai.request.model": info.model,
          "studio.model": `${info.provider}:${info.model}`,
          "studio.run.id": info.runId,
          ...(info.thinking ? { "studio.thinking_level": info.thinking } : {}),
          ...(info.profile ? { "studio.profile": info.profile } : {}),
        },
      },
      parent,
    );
    this.ctx = trace.setSpan(parent, this.span);
  }

  /** The run's trace id, or undefined when no SDK is recording. */
  get traceId(): string | undefined {
    return validTraceId(this.span.spanContext().traceId);
  }

  onEvent(e: AgentSessionEvent): void {
    if (this.ended) return;
    switch (e.type) {
      case "message_start":
        if ((e.message as { role?: string })?.role === "assistant") {
          this.chat?.end();
          this.chat = this.start(`chat ${this.info.model}`, SpanKind.CLIENT, {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": this.info.provider,
            "gen_ai.request.model": this.info.model,
          });
        }
        return;
      case "message_end": {
        const m = e.message as any;
        if (m?.role !== "assistant") return;
        const span = this.chat ?? this.start(`chat ${this.info.model}`, SpanKind.CLIENT, { "gen_ai.operation.name": "chat", "gen_ai.provider.name": this.info.provider, "gen_ai.request.model": this.info.model });
        this.chat = undefined;
        if (typeof m.model === "string") span.setAttribute("gen_ai.response.model", m.model);
        if (typeof m.provider === "string") span.setAttribute("gen_ai.provider.name", m.provider);
        if (typeof m.stopReason === "string") span.setAttribute("gen_ai.response.finish_reasons", [m.stopReason]);
        const u = m.usage;
        if (u) {
          const cost = Number(u.cost?.total ?? 0);
          this.costUsd += cost;
          this.usage.input += u.input ?? 0;
          this.usage.output += u.output ?? 0;
          this.usage.cached += u.cacheRead ?? 0;
          span.setAttributes({
            "gen_ai.usage.input_tokens": u.input ?? 0,
            "gen_ai.usage.output_tokens": u.output ?? 0,
            "gen_ai.usage.cache_read.input_tokens": u.cacheRead ?? 0,
            "gen_ai.usage.cache_creation.input_tokens": u.cacheWrite ?? 0,
            "studio.cost_usd": cost,
          });
        }
        if (m.stopReason === "error" || m.stopReason === "aborted") {
          span.setAttribute("error.type", m.stopReason === "aborted" ? "aborted" : "provider_error");
          span.setStatus({ code: SpanStatusCode.ERROR, message: m.errorMessage ? sanitizeError(String(m.errorMessage)) : m.stopReason });
        }
        span.end();
        return;
      }
      case "tool_execution_start":
        this.toolSpan(e.toolCallId, e.toolName);
        return;
      case "tool_execution_end": {
        const span = this.toolSpan(e.toolCallId, e.toolName);
        this.tools.delete(e.toolCallId);
        if (e.isError) {
          // The error's text is the tool result (content): only its class goes on the span.
          span.setAttribute("error.type", "tool_error");
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        span.end();
        return;
      }
      case "compaction_start":
        this.compaction?.end();
        this.compaction = this.start("compaction", SpanKind.INTERNAL, { "studio.compaction.reason": String((e as any).reason ?? "") });
        return;
      case "compaction_end": {
        const span = this.compaction ?? this.start("compaction", SpanKind.INTERNAL, {});
        this.compaction = undefined;
        span.setAttribute("studio.compaction.aborted", !!e.aborted);
        span.end();
        return;
      }
      default:
        return;
    }
  }

  /**
   * The context a tool's `execute` runs in: its `execute_tool` span is active, so the
   * `traceparent` that `installFetchPropagation` adds to kernel calls points at the tool call.
   */
  toolContext(toolCallId: string, toolName: string): Context {
    return trace.setSpan(this.ctx, this.toolSpan(toolCallId, toolName));
  }

  /** End the run span (and anything still open) with the run's final status. */
  end(status: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const s of [this.chat, this.compaction, ...this.tools.values()]) {
      if (!s) continue;
      s.setStatus({ code: SpanStatusCode.ERROR, message: `run ${status}` });
      s.end();
    }
    this.tools.clear();
    this.span.setAttributes({
      "studio.run.status": status,
      "studio.cost_usd": this.costUsd,
      "gen_ai.usage.input_tokens": this.usage.input,
      "gen_ai.usage.output_tokens": this.usage.output,
      "gen_ai.usage.cache_read.input_tokens": this.usage.cached,
    });
    if (status !== "completed") this.span.setStatus({ code: SpanStatusCode.ERROR, message: `run ${status}` });
    this.span.end();
  }

  private toolSpan(toolCallId: string, toolName: string): Span {
    let span = this.tools.get(toolCallId);
    if (!span) {
      span = this.start(`execute_tool ${toolName}`, SpanKind.INTERNAL, {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        "gen_ai.tool.call.id": toolCallId,
      });
      this.tools.set(toolCallId, span);
    }
    return span;
  }

  private start(name: string, kind: SpanKind, attributes: Record<string, string | number | boolean>): Span {
    return tracer().startSpan(name, { kind, attributes }, this.ctx);
  }
}

/**
 * Run each tool's `execute` inside its `execute_tool` span's context. `tracer` returns the
 * session's current run tracer (none between runs: the tool then runs in the caller's context).
 */
export function withToolContext<T extends { name: string; execute: (...args: any[]) => any }>(tool: T, current: () => RunTracer | undefined): T {
  const execute = tool.execute;
  return {
    ...tool,
    execute(this: unknown, toolCallId: string, ...rest: unknown[]) {
      const t = current();
      return t ? context.with(t.toolContext(toolCallId, tool.name), () => execute.call(this, toolCallId, ...rest)) : execute.call(this, toolCallId, ...rest);
    },
  };
}
