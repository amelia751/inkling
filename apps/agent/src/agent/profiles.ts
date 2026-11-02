import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NAMING } from "../naming.ts";
import type { ProfileName } from "@studio/agent-protocol";

const PROMPTS = resolve(import.meta.dirname, "prompts");
/** Prompts name the product through `{{displayName}}` (naming config), never literally. */
const prompt = (name: string) =>
  readFileSync(resolve(PROMPTS, `${name}.md`), "utf8")
    .trim()
    .replaceAll("{{displayName}}", NAMING.displayName);

export const CARD_TOOLS = ["show_items", "propose_label_schema", "draft_document", "suggest_tool", "propose_review", "select_annotations", "open_location", "propose_reorganization", "request_upload", "offer_specialist"] as const;
export const ENVIRONMENT_TOOLS = [
  "list_modules",
  "describe_contribution",
  "get_environment",
  "validate_environment",
  "preview_environment",
  "patch_environment",
  "list_capabilities",
  "inspect_plugin",
  "run_command",
] as const;

/**
 * Browser tools a builder session ignores because the kernel answers them (server tools of the
 * same name): the browser's versions only see the bundled registry, not the workspace's installs.
 */
export const KERNEL_SHADOWED = ["list_capabilities", "inspect_plugin"] as const;

export interface Profile {
  name: ProfileName;
  /** Browser-registered tools this profile accepts; anything else is rejected at session creation. */
  clientTools: readonly string[];
  /** `optional`: sandbox tools when Daytona is configured, otherwise the profile runs without them. */
  sandbox: boolean | "optional";
  /** Server tools over the kernel (tools/kernel.ts); the session needs a kernel token. */
  kernel?: "builder" | "task";
  /**
   * Studio server tools (tools/studio.ts, todo11): boot_studio, patch_studio, get_studio_state,
   * search_catalog, offer_studio. The `boot` prompt comes last in `prompts`, followed by the
   * compact preset index.
   */
  studio?: boolean;
  prompts: string[];
}

/** Host-owned: the client picks a profile by name, never by capability. */
export const PROFILES: Record<ProfileName, Profile> = {
  // The one general assistant the Studio offers: cards, environment editing and the task tools.
  // coder and builder are reached only through offer_specialist (a hand-off the user approves).
  assistant: {
    name: "assistant",
    clientTools: [...CARD_TOOLS, ...ENVIRONMENT_TOOLS],
    sandbox: false,
    studio: true,
    kernel: "task",
    prompts: ["base", "environment", "task", "specialists", "boot"],
  },
  // environment-designer and task are kept for API compatibility; the Studio no longer offers them.
  "environment-designer": {
    name: "environment-designer",
    clientTools: [...CARD_TOOLS, ...ENVIRONMENT_TOOLS],
    sandbox: false,
    studio: true,
    prompts: ["base", "environment", "boot"],
  },
  coder: { name: "coder", clientTools: [...CARD_TOOLS, ...ENVIRONMENT_TOOLS], sandbox: true, studio: true, prompts: ["base", "environment", "coding", "boot"] },
  // Builder tools plus environment client tools; no data-plane writes (no run_command, no
  // gateway). Its sandbox, when there is one, only holds plugin source (Phase 9).
  builder: {
    name: "builder",
    clientTools: [...CARD_TOOLS, ...ENVIRONMENT_TOOLS.filter((t) => t !== "run_command" && !(KERNEL_SHADOWED as readonly string[]).includes(t))],
    sandbox: "optional",
    kernel: "builder",
    prompts: ["base", "environment", "builder"],
  },
  // Task tools only: uses what's installed, can't change the plugin set or the environment.
  task: { name: "task", clientTools: CARD_TOOLS, sandbox: false, kernel: "task", prompts: ["base", "task"] },
};

/** Whether the profile can run here (a hard sandbox requirement needs Daytona). */
export const profileAvailable = (p: Profile, sandboxes: boolean) => p.sandbox !== true || sandboxes;

export function isProfileName(name: string): name is ProfileName {
  return Object.hasOwn(PROFILES, name);
}

/**
 * The system prompt, in a fixed order so providers can cache it (todo11): the profile's prompt
 * files in their listed order, then the compact preset index (static per deployment: it changes
 * only with the catalogue), then `dynamic` parts last. Per-turn state goes in user messages, not
 * here. The browser's `catalogPrompt` is no longer part of it.
 */
export function systemPrompt(profile: Profile, parts: { studioIndex?: string; dynamic?: (string | undefined)[] } = {}): string {
  return [...profile.prompts.map(prompt), profile.studio ? parts.studioIndex : undefined, ...(parts.dynamic ?? [])].filter(Boolean).join("\n\n");
}
