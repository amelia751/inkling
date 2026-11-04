import { anthropic } from "./anthropic.ts";
import { muse } from "./muse.ts";
import { openai } from "./openai.ts";
import type { ModelProvider } from "./types.ts";

export type { ModelProvider } from "./types.ts";

export const PROVIDERS: readonly ModelProvider[] = [muse, openai, anthropic];

/** The default model is this provider's first model; `AGENT_MODEL` overrides it. */
export const ACTIVE: ModelProvider = muse;

export const DEFAULT_MODEL = `${ACTIVE.id}:${ACTIVE.models[0]}`;
export const DEFAULT_ALLOWLIST = PROVIDERS.flatMap((p) => p.models.map((m) => `${p.id}:${m}`)).join(",");
