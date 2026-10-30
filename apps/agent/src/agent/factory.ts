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
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import { dataDir, resolveModel } from "./models.ts";

export interface SessionDeps {
  config: Config;
  runtime: ModelRuntime;
  cwd: string;
  systemPrompt: string;
  tools: ToolDefinition<any, any, any>[];
  extensions: ExtensionFactory[];
  /** Restored history (runtime/sessions.ts); a fresh in-memory manager otherwise. */
  sessionManager?: SessionManager;
  model?: Model<Api>;
}

/**
 * A pi session with nothing discovered from disk: no AGENTS.md, skills, prompt templates, themes or
 * extensions from the host or ~/.pi. Only the tools passed in are enabled (pi's built-ins are not).
 */
export async function createInklingSession(deps: SessionDeps): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } });
  const agentDir = join(dataDir(deps.config), "pi");
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
    // An override, not `systemPrompt`: pi reads a `systemPrompt` string as a file path whenever a
    // file of that name exists, and would otherwise look for SYSTEM.md in cwd/agentDir.
    systemPromptOverride: () => deps.systemPrompt,
    appendSystemPrompt: [],
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: deps.cwd,
    agentDir,
    model: deps.model ?? resolveModel(deps.runtime, deps.config),
    thinkingLevel: deps.config.model.thinking,
    modelRuntime: deps.runtime,
    resourceLoader,
    sessionManager: deps.sessionManager ?? SessionManager.inMemory(deps.cwd),
    settingsManager,
    customTools: deps.tools,
    // pi's own read/bash/edit/write would run on the host: never enable them.
    noTools: "builtin",
    tools: deps.tools.map((t) => t.name),
  });
  return session;
}
