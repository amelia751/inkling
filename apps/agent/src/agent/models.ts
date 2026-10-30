import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";

export const DATA_DIR = resolve(import.meta.dirname, "../../.data");

/** One runtime per process. Keys come from config; nothing is read from or written to ~/.pi. */
export async function createModelRuntime(config: Config): Promise<ModelRuntime> {
  mkdirSync(DATA_DIR, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: join(DATA_DIR, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  for (const [provider, key] of Object.entries(config.providerKeys)) await runtime.setRuntimeApiKey(provider, key);
  return runtime;
}

export function resolveModel(runtime: ModelRuntime, config: Config, ref = `${config.model.provider}:${config.model.id}`) {
  if (!config.model.allowlist.includes(ref)) throw new Error(`model ${ref} is not in AGENT_MODEL_ALLOWLIST`);
  const [provider, ...rest] = ref.split(":");
  const model = runtime.getModel(provider!, rest.join(":"));
  if (!model) throw new Error(`model ${ref} is unknown to pi ${provider}`);
  if (!config.providerKeys[provider!]) throw new Error(`no API key for provider ${provider}`);
  return model;
}
