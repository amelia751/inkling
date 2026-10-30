import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProfileName } from "../protocol.ts";

const PROMPTS = resolve(import.meta.dirname, "prompts");
const prompt = (name: string) => readFileSync(resolve(PROMPTS, `${name}.md`), "utf8").trim();

export const CARD_TOOLS = ["show_items", "propose_label_schema", "draft_document", "suggest_tool", "propose_review", "select_annotations"] as const;
export const ENVIRONMENT_TOOLS = [
  "list_modules",
  "describe_contribution",
  "get_environment",
  "validate_environment",
  "preview_environment",
  "patch_environment",
  "run_command",
] as const;

export interface Profile {
  name: ProfileName;
  /** Browser-registered tools this profile accepts; anything else is rejected at session creation. */
  clientTools: readonly string[];
  sandbox: boolean;
  prompts: string[];
}

/** Host-owned: the client picks a profile by name, never by capability. */
export const PROFILES: Record<ProfileName, Profile> = {
  assistant: { name: "assistant", clientTools: CARD_TOOLS, sandbox: false, prompts: ["base"] },
  "environment-designer": {
    name: "environment-designer",
    clientTools: [...CARD_TOOLS, ...ENVIRONMENT_TOOLS],
    sandbox: false,
    prompts: ["base", "environment"],
  },
  coder: { name: "coder", clientTools: [...CARD_TOOLS, ...ENVIRONMENT_TOOLS], sandbox: true, prompts: ["base", "environment", "coding"] },
};

export function isProfileName(name: string): name is ProfileName {
  return Object.hasOwn(PROFILES, name);
}

export function systemPrompt(profile: Profile, extra: (string | undefined)[] = []): string {
  return [...profile.prompts.map(prompt), ...extra.filter(Boolean)].join("\n\n");
}
