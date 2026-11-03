import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Config, SCRIPTED_PROVIDER } from "../config.ts";
import { resolveModel } from "./models.ts";

/**
 * todo21 D4: a chat names itself after its first exchange. The input is ONLY the first user
 * message's own words and the first reply's text (never tool calls or tool outputs). One call, no
 * tools, at most 30 output tokens, on the cheapest allowlisted model with a key. With the scripted
 * model, or no usable model, or when the call fails, a heuristic names it instead.
 */

export const TITLE_MAX = 80;
const MAX_WORDS = 6;
const INPUT_CHARS = 2000;

export interface TitleResult {
  title: string;
  via: "model" | "heuristic";
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

const FILLER = /^(?:(?:hi|hey|hello)[,!]?\s+)?(?:(?:please|pls|can you|could you|would you|will you|i want to|i'd like to|i would like to|help me(?: to)?|let's|lets)\s+)+/i;

/** The first clause of the message, up to six words, capitalised; null when there are no words. */
export function heuristicTitle(text: string): string | null {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  const clause = line.split(/[.!?;:\n]|,\s|\s[-–—]\s/)[0]!.trim() || line;
  const words = clause.replace(FILLER, "").split(" ").filter(Boolean);
  const picked = (words.length ? words : clause.split(" ")).slice(0, MAX_WORDS).join(" ").replace(/[\s,;:.!?…-]+$/, "");
  if (!picked) return null;
  return clean(picked.charAt(0).toUpperCase() + picked.slice(1));
}

/** One line, no quotes or trailing punctuation, at most 80 characters. */
export function clean(raw: string): string | null {
  const s = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^title:\s*/i, "")
    .replace(/^["'“”‘’`*]+|["'“”‘’`*]+$/g, "")
    .replace(/[.。!]+$/, "")
    .trim();
  if (!s) return null;
  return s.length <= TITLE_MAX ? s : s.slice(0, TITLE_MAX).trimEnd();
}

/** The cheapest allowlisted, non-scripted model this service has a key for (by catalogue price). */
export function cheapestModel(runtime: ModelRuntime, config: Config): Model<Api> | undefined {
  let best: { model: Model<Api>; price: number } | undefined;
  for (const ref of config.model.allowlist) {
    if (ref.startsWith(`${SCRIPTED_PROVIDER}:`)) continue;
    let model: Model<Api>;
    try {
      model = resolveModel(runtime, config, ref);
    } catch {
      continue;
    }
    const cost = (model as { cost?: { input?: number; output?: number } }).cost;
    const price = (Number(cost?.input) || 0) + (Number(cost?.output) || 0);
    if (!best || price < best.price) best = { model, price };
  }
  return best?.model;
}

const SYSTEM = "You name chat threads. Reply with a 2 to 6 word title for the conversation below, in the user's language. No quotes, no punctuation at the end, nothing else.";

export async function makeTitle(
  input: { userText: string; replyText: string },
  deps: { runtime: ModelRuntime; config: Config; signal?: AbortSignal },
): Promise<TitleResult | null> {
  const fallback = (): TitleResult | null => {
    const t = heuristicTitle(input.userText) ?? heuristicTitle(input.replyText);
    return t ? { title: t, via: "heuristic" } : null;
  };
  if (deps.config.model.provider === SCRIPTED_PROVIDER) return fallback();
  const model = cheapestModel(deps.runtime, deps.config);
  if (!model) return fallback();
  const content = `<user_message>\n${input.userText.slice(0, INPUT_CHARS)}\n</user_message>\n<assistant_reply>\n${input.replyText.slice(0, INPUT_CHARS)}\n</assistant_reply>`;
  try {
    const msg: AssistantMessage = await deps.runtime.completeSimple(
      model,
      { systemPrompt: SYSTEM, messages: [{ role: "user", content, timestamp: Date.now() }] },
      { maxTokens: 30, signal: deps.signal, timeoutMs: 15_000, maxRetries: 1 } as never,
    );
    const text = (Array.isArray(msg.content) ? msg.content : []).map((c) => (c.type === "text" ? c.text : "")).join("");
    const title = msg.stopReason === "error" ? null : clean(text.split("\n").find((l) => l.trim()) ?? "");
    const u = msg.usage;
    const usage = u ? { inputTokens: u.input ?? 0, outputTokens: u.output ?? 0, costUsd: u.cost?.total ?? 0 } : undefined;
    if (!title) return fallback();
    return { title, via: "model", model: `${model.provider}:${model.id}`, ...(usage ? { usage } : {}) };
  } catch {
    return fallback();
  }
}
