import type { ModelProvider } from "./types.ts";

export const openai: ModelProvider = {
  id: "openai",
  keyEnv: "OPENAI_API_KEY",
  models: ["gpt-6.1-sol", "gpt-6-sol"],
};
