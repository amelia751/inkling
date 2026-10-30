/**
 * Wire types between apps/web and apps/agent (`import type { … } from "@studio/agent-protocol"`).
 * Types only: nothing here may import runtime code.
 *
 * Flow: POST /v1/sessions → POST /v1/sessions/:id/messages → GET /v1/runs/:runId/events (SSE,
 * resumable with `?after=seq` or Last-Event-ID). Client tools and approvals are answered with
 * POST /v1/runs/:runId/client-tools/:callId and POST /v1/approvals/:approvalId.
 */

export type ProfileName = "assistant" | "environment-designer" | "coder";

export type RunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "expired";

export type SandboxState = "creating" | "ready" | "resumed" | "stopped" | "deleted" | "unavailable";

/** Same shape as `AGENT_TOOLS` in apps/web/src/platform/agent.ts (Messages-API tool spec). */
export interface ClientToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** Shown on the tool row while it runs, e.g. "Editing environment". */
  title?: string;
}

/**
 * The text-only dataset snapshot the Studio shares (with the expert's consent). Never pixels, files
 * or DICOM headers; item names are the dataset's own de-identified ids. The dataset tools read it.
 */
export interface DatasetSnapshot {
  project: {
    id: string;
    title: string;
    viewer: string;
    task?: string;
    labels: string[];
    license: string;
    source: string;
    restricted: boolean;
  };
  items: {
    id: string;
    name: string;
    group: string;
    sourceLabel?: string;
    /** Seed-relative file paths behind this item; only these can be copied into a sandbox. */
    assets?: string[];
  }[];
  annotations: {
    id: string;
    itemId: string;
    label: string;
    type: string;
    provenance: "human-created" | "ai-suggested" | "human-corrected";
    /** Human-readable shape summary, e.g. "Box 163×157 px". */
    summary: string;
  }[];
  currentItemId?: string;
  selectedIds: string[];
  /** Tools the current viewer offers, so the agent only suggests real ones. */
  tools: string[];
  unsavedChanges: boolean;
}

/** Structured output the panel renders as an interactive card. Cards only act on the expert's click. */
export type AgentCard =
  | { kind: "items"; title: string; itemIds: string[] }
  | { kind: "label-schema"; title: string; labels: { name: string; description: string; color?: string }[] }
  | { kind: "document"; title: string; filename: string; markdown: string }
  | { kind: "tool-switch"; tool: string; label?: string; reason: string }
  | { kind: "review-suggestions"; action: "accept" | "reject"; annotationIds: string[]; reason: string }
  | { kind: "select-annotations"; annotationIds: string[]; reason: string };

export type AgentEventBody =
  | { type: "start"; model: string }
  | { type: "run-status"; status: RunStatus }
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool-call"; id: string; name: string; title: string }
  | { type: "tool-progress"; id: string; text: string }
  | { type: "tool-result"; id: string; ok: boolean; summary: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }
  | { type: "status"; text: string }
  | { type: "client-tool"; callId: string; name: string; input: unknown }
  | { type: "approval"; approvalId: string; toolCallId: string; toolName: string; summary: string; inputPreview: string; expiresAt: number }
  | { type: "approval-resolved"; approvalId: string; decision: "approve" | "reject" }
  | { type: "sandbox"; state: SandboxState; sandboxId?: string }
  | { type: "artifact"; id: string; name: string; bytes: number; sha256: string }
  | { type: "error"; message: string }
  | { type: "done"; status: RunStatus };

/** Every event carries its run, a per-run sequence number (monotonic from 1) and a timestamp (ms). */
export type AgentEvent = AgentEventBody & { seq: number; runId: string; at: number };

export interface CreateSessionRequest {
  projectId: string;
  profile?: ProfileName;
  clientTools?: ClientToolSpec[];
  /** Module catalogue rendered by the browser (environment profiles); the service never imports web code. */
  catalogPrompt?: string;
  /** Restricted licence: no sandbox egress, approval before dataset uploads. */
  restricted?: boolean;
}

export interface CreateSessionResponse {
  sessionId: string;
  profile: ProfileName;
  model: string;
}

export interface SendMessageRequest {
  text: string;
  /** Per-turn state shown to the model with this message, e.g. the `<environment>` block. */
  context?: string;
  /** Dataset snapshot for the dataset tools; replaces the session's previous one. */
  snapshot?: DatasetSnapshot;
}

export interface SendMessageResponse {
  runId: string;
  /** True when the message was steered into a run that was already active. */
  steered: boolean;
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
  model: string | null;
  sandbox: "daytona" | "off";
  profiles: ProfileName[];
}

export interface ArtifactInfo {
  id: string;
  name: string;
  bytes: number;
  sha256: string;
  createdAt: number;
}

export interface SessionInfo {
  sessionId: string;
  projectId: string;
  profile: ProfileName;
  createdAt: number;
  activeRunId?: string;
  sandbox?: { id: string; state?: string };
  artifacts: ArtifactInfo[];
}
