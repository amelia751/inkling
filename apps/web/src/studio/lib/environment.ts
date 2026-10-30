import { FileIcon, type IconComponent } from "@studio/studio-ui/icons";
import { registry } from "@/extension-host/registry";
import { normalizeProject } from "./api";
import { resolveEnvironment, type ResolvedEnv, type ResolveResult } from "@/extension-host/resolve";
import type { Project } from "@studio/plugin-contracts/types";

/**
 * The shell's bridge from a project to its environment. Resolution is pure and cheap, so
 * it's memoised per project object (React Query keeps project objects stable).
 */
const cache = new WeakMap<Project, ResolveResult>();

export function projectEnv(project: Project): ResolveResult {
  let r = cache.get(project);
  // A raw v1 manifest entry (scripts, tests) is migrated on the fly.
  if (!r) cache.set(project, (r = resolveEnvironment((project.environment ? project : normalizeProject(project as never)).environment, registry)));
  return r;
}

/** The resolved environment, or undefined when the spec has errors (callers show them). */
export function envOf(project: Project): ResolvedEnv | undefined {
  return projectEnv(project).env;
}

export function envLabel(env: ResolvedEnv | undefined): string {
  return env?.dataKind.label ?? "Unknown data";
}

export function envIcon(env: ResolvedEnv | undefined): IconComponent | undefined {
  return env?.dataKind.icon;
}

/** Singular noun for the unit an expert works through ("slide", "recording"). */
export function itemNoun(env: ResolvedEnv | undefined): string {
  return env?.dataKind.itemNoun ?? "item";
}

/** Icon for a project's data kind (the dataset switcher, cards). */
export function projectIcon(project: Project): IconComponent {
  return envIcon(envOf(project)) ?? FileIcon;
}
