import { join } from "node:path";
import {
  type AgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "../config.ts";
import { DATA_DIR, resolveModel } from "./models.ts";

export interface SessionDeps {
  config: Config;
  runtime: ModelRuntime;
  cwd: string;
  systemPrompt: string;
  tools: ToolDefinition<any, any, any>[];
  extensions: ExtensionFactory[];
}

/**
 * A pi session with nothing discovered from disk: no AGENTS.md, skills, prompt templates, themes or
 * extensions from the host or ~/.pi. Only the tools passed in are enabled (pi's built-ins are not).
 */
export async function createInklingSession(deps: SessionDeps): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } } as any);
  const agentDir = join(DATA_DIR, "pi");
  const resourceLoader = new DefaultResourceLoader({
    cwd: deps.cwd,
    agentDir,
    settingsManager,
    extensionFactories: deps.extensions,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: deps.systemPrompt,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: deps.cwd,
    agentDir,
    model: resolveModel(deps.runtime, deps.config),
    thinkingLevel: deps.config.model.thinking,
    modelRuntime: deps.runtime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(deps.cwd),
    settingsManager,
    customTools: deps.tools,
    tools: deps.tools.map((t) => t.name),
  });
  return session;
}
