import type { ClientToolSpec, ProfileName } from "@studio/agent-protocol";
import { AGENT_TOOLS, agentSystemPrompt } from "@/extension-host/agent";
import { CARD_TOOLS } from "./card-tools";

/**
 * How a session is set up for a profile, the same in the Studio's panel and the project drawer
 * (todo6 Phase 6): one session per project, so the model's conversation carries across sections.
 * Outside the Studio the environment tools answer "open the Studio".
 */

const ENV_TITLES: Record<string, string> = {
  list_modules: "Listing modules",
  describe_contribution: "Reading contribution",
  get_environment: "Reading environment",
  validate_environment: "Validating environment",
  preview_environment: "Previewing environment",
  patch_environment: "Editing environment",
  run_command: "Running command",
};
export const ENV_TOOLS: ClientToolSpec[] = AGENT_TOOLS.map((t) => ({ ...t, title: ENV_TITLES[t.name] }));
export const ENV_TOOL_NAMES = new Set(ENV_TOOLS.map((t) => t.name));

export const PROFILES: { id: ProfileName; label: string; hint: string }[] = [
  { id: "assistant", label: "Dataset assistant", hint: "Questions, checks, label sets, docs" },
  { id: "environment-designer", label: "Environment designer", hint: "Also edits tools, panels, labels" },
  { id: "coder", label: "Coder (sandbox)", hint: "Also runs code in a private sandbox" },
  { id: "builder", label: "Plugin builder", hint: "Finds, installs and builds plugins; you approve installs" },
  { id: "task", label: "Task runner", hint: "Runs installed capabilities, e.g. segmentation" },
];

/** The builder gets these from the kernel (workspace installs) and may not run Studio commands. */
const BUILDER_EXCLUDED = new Set(["run_command", "list_capabilities", "inspect_plugin"]);

/** Tools the browser registers for a profile; the service checks them against its own allowlist. */
export const clientToolsFor = (profile: ProfileName) =>
  profile === "assistant" || profile === "task"
    ? CARD_TOOLS
    : profile === "builder"
      ? [...CARD_TOOLS, ...ENV_TOOLS.filter((t) => !BUILDER_EXCLUDED.has(t.name))]
      : [...CARD_TOOLS, ...ENV_TOOLS];

/** Profiles that see (and may edit) the environment. */
export const envProfile = (profile: ProfileName) => profile !== "assistant" && profile !== "task";

/** Session options for a profile (the catalogue comes from the registry, loaded at boot). */
export const sessionTools = (profile: ProfileName) => ({
  profile,
  clientTools: clientToolsFor(profile),
  catalogPrompt: envProfile(profile) ? agentSystemPrompt() : undefined,
});
