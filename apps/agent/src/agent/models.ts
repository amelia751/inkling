import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { type FauxContentBlock, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Config, SCRIPTED_PROVIDER, envName } from "../config.ts";
import { PROVIDERS } from "./providers/index.ts";

export const DEFAULT_DATA_DIR = resolve(import.meta.dirname, "../../.data");
export const dataDir = (config: Config) => resolve(config.dataDir ?? DEFAULT_DATA_DIR);

/** One runtime per process. Keys come from config; nothing is read from or written to ~/.pi. */
export async function createModelRuntime(config: Config): Promise<ModelRuntime> {
  const dir = dataDir(config);
  mkdirSync(dir, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  for (const p of PROVIDERS) if (config.providerKeys[p.id]) p.register?.(runtime);
  for (const [provider, key] of Object.entries(config.providerKeys)) await runtime.setRuntimeApiKey(provider, key);
  if (config.model.provider === SCRIPTED_PROVIDER) registerScriptedProvider(runtime, config.script ? loadScript(config.script) : { scripts: [] });
  return runtime;
}

export function resolveModel(runtime: ModelRuntime, config: Config, ref = `${config.model.provider}:${config.model.id}`): Model<Api> {
  if (!config.model.allowlist.includes(ref)) throw new Error(`model ${ref} is not in ${envName("AGENT_MODEL_ALLOWLIST")}`);
  const [provider, ...rest] = ref.split(":");
  const model = runtime.getModel(provider!, rest.join(":"));
  if (!model) throw new Error(`model ${ref} is unknown to pi ${provider}`);
  if (provider !== SCRIPTED_PROVIDER && !config.providerKeys[provider!]) throw new Error(`no API key for provider ${provider}`);
  return model;
}

/**
 * Scripted model (AGENT_MODEL=scripted, dev/test only): replays a fixture instead of calling a
 * provider, for e2e tests and offline development.
 *
 * Fixture: `{ "scripts": [{ "when": "<regex on the latest user message>", "turns": [Turn, …] }] }`.
 * The first script whose `when` matches the latest user message is used; the turn index is the
 * number of assistant messages since that user message, so each run replays its script from the
 * start. Past the last turn the model says it has nothing scripted. A string argument
 * `"{{last.a.b}}"` is replaced by field `a.b` of the latest tool result's JSON (e.g. a request id
 * the previous call returned); `"{{when.N}}"` by capture group N of the script's `when` on the
 * latest user message (e.g. the drop id of a `<drop id="…">` block).
 */
export interface ScriptTurn {
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; arguments?: Record<string, unknown> }[];
}
export interface ScriptFixture {
  scripts: { when?: string; turns: ScriptTurn[] }[];
}

export function loadScript(path: string): ScriptFixture {
  const raw = JSON.parse(readFileSync(path, "utf8")) as ScriptFixture | ScriptTurn[];
  return Array.isArray(raw) ? { scripts: [{ turns: raw }] } : raw;
}

const textOf = (m: Message) =>
  typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("");

function lastToolJson(messages: readonly Message[]): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "toolResult") continue;
    try {
      return JSON.parse(textOf(m));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function resolveRefs(value: unknown, last: () => unknown, when: RegExpExecArray | null = null): unknown {
  if (typeof value === "string") {
    const group = value.match(/^\{\{when\.(\d+)\}\}$/)?.[1];
    if (group) return when?.[Number(group)] ?? value;
    const ref = value.match(/^\{\{last\.([\w.]+)\}\}$/)?.[1];
    return ref ? ref.split(".").reduce<any>((o, k) => o?.[k], last()) : value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, last, when));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, last, when)]));
  return value;
}

export function scriptedReply(fixture: ScriptFixture, messages: readonly Message[]) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]!.role === "user") {
      lastUser = i;
      break;
    }
  const prompt = lastUser >= 0 ? textOf(messages[lastUser]!) : "";
  const turn = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
  const script = fixture.scripts.find((s) => !s.when || new RegExp(s.when, "i").test(prompt));
  const step = script?.turns[turn];
  if (!step) return fauxAssistantMessage("(The scripted model has nothing more to say.)");
  const blocks: FauxContentBlock[] = [];
  if (step.thinking) blocks.push(fauxThinking(step.thinking));
  if (step.text) blocks.push(fauxText(step.text));
  const last = () => lastToolJson(messages);
  const when = script?.when ? new RegExp(script.when, "i").exec(prompt) : null;
  for (const c of step.toolCalls ?? []) blocks.push(fauxToolCall(c.name, resolveRefs(c.arguments ?? {}, last, when) as never));
  return fauxAssistantMessage(blocks, { stopReason: step.toolCalls?.length ? "toolUse" : "stop" });
}

export function registerScriptedProvider(runtime: ModelRuntime, fixture: ScriptFixture): void {
  const faux = fauxProvider({
    provider: SCRIPTED_PROVIDER,
    models: [{ id: "replay", name: "Scripted replay", contextWindow: 200_000, maxTokens: 8192 }],
    tokensPerSecond: 2000,
  });
  // A factory per call keeps the script stateless: the transcript alone picks the turn.
  const step = (context: { messages: Message[] }) => scriptedReply(fixture, context.messages);
  faux.setResponses(Array.from({ length: 10_000 }, () => step));
  runtime.registerNativeProvider(faux.provider);
}
