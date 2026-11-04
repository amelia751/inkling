import type { ModelProvider } from "./types.ts";

/** Meta Model API: OpenAI-compatible Responses endpoint. Prices are USD per million tokens. */
const BASE_URL = "https://api.meta.ai/v1";

const MODELS = [
  { id: "muse-spark-1.3", name: "Muse Spark 1.3", cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 } },
  { id: "muse-wonder-1.0", name: "Muse Wonder 1.0", cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 } },
];

export const muse: ModelProvider = {
  id: "muse",
  keyEnv: "AGENT_MUSE_API_KEY",
  models: MODELS.map((m) => m.id),
  register: (runtime) =>
    runtime.registerProvider("muse", {
      name: "Meta Model API",
      baseUrl: BASE_URL,
      api: "openai-responses",
      models: MODELS.map((m) => ({
        ...m,
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_048_576,
        maxTokens: 131_072,
      })),
    }),
};
