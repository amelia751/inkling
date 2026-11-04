import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ModelProvider {
  /** The prefix in `AGENT_MODEL` (`<id>:<model>`) and the pi provider id. */
  id: string;
  /** Settings key holding the API key, as config.ts names it. */
  keyEnv: string;
  /** Allowlisted model ids, default first. */
  models: string[];
  /** For providers pi doesn't ship: adds them to the runtime before keys are set. */
  register?: (runtime: ModelRuntime) => void;
}
