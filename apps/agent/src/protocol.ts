/**
 * Wire types shared with apps/web (`import type { … } from "@inkling/agent/protocol"`).
 * Types only: nothing here may import runtime code.
 */

export type ProfileName = "assistant" | "environment-designer" | "coder";

export type RunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "expired";

export type SandboxState = "creating" | "ready" | "resumed" | "stopped" | "deleted" | "unavailable";

/** Same shape as `AGENT_TOOLS` in apps/web/src/platform/agent.ts (Messages-API tool spec). */
export interface ClientToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type AgentEventBody =
  | { type: "start"; model: string }
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool-call"; id: string; name: string; title: string }
  | { type: "tool-progress"; id: string; text: string }
  | { type: "tool-result"; id: string; ok: boolean; summary: string; input: unknown; card?: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: "status"; text: string }
  | { type: "client-tool"; callId: string; name: string; input: unknown }
  | { type: "approval"; approvalId: string; toolCallId: string; toolName: string; summary: string; inputPreview: string }
  | { type: "sandbox"; state: SandboxState; sandboxId?: string }
  | { type: "error"; message: string }
  | { type: "done"; status: RunStatus };

export type AgentEvent = AgentEventBody & { seq: number; runId: string; at: number };

export interface CreateSessionRequest {
  projectId: string;
  profile: ProfileName;
  clientTools?: ClientToolSpec[];
  /** Environment catalogue / system context rendered by the browser (environment-designer). */
  catalogPrompt?: string;
  restricted?: boolean;
}

export interface CreateSessionResponse {
  sessionId: string;
}

export interface SendMessageRequest {
  text: string;
  /** Per-turn context from the Studio (dataset snapshot, open item), appended to the prompt. */
  context?: string;
}

export interface SendMessageResponse {
  runId: string;
  steered?: boolean;
}

export interface ClientToolResultRequest {
  ok: boolean;
  output: unknown;
}

export interface ApprovalDecisionRequest {
  decision: "approve" | "reject";
  note?: string;
}

export interface AgentStatus {
  configured: boolean;
  provider: string;
  model: string;
  sandbox: "daytona" | "off";
}

export interface SessionInfo {
  sessionId: string;
  projectId: string;
  profile: ProfileName;
  createdAt: number;
  activeRunId?: string;
  sandbox?: { id: string; state?: string };
  artifacts: { id: string; name: string; bytes: number; sha256: string }[];
}
