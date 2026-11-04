import type { ModelProvider } from "./types.ts";

export const anthropic: ModelProvider = {
  id: "anthropic",
  keyEnv: "ANTHROPIC_API_KEY",
  models: ["claude-sonnet-5-5", "claude-opus-5-5"],
};
