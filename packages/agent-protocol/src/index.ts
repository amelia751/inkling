/**
 * Wire types between apps/web and apps/agent (`import type { … } from "@studio/agent-protocol"`).
 * Types only: nothing here may import runtime code.
 *
 * Flow: POST /v1/sessions → POST /v1/sessions/:id/messages → GET /v1/runs/:runId/events (SSE,
 * resumable with `?after=seq` or Last-Event-ID). Client tools and approvals are answered with
 * POST /v1/runs/:runId/client-tools/:callId and POST /v1/approvals/:approvalId.
 */

/**
 * `builder` changes which plugins run in the workspace (kernel builder tools, no data writes);
 * `task` uses active capabilities through the gateway (no plugin changes). docs/plugins.md §8.
 */
export type ProfileName = "assistant" | "environment-designer" | "coder" | "builder" | "task";

/**
 * Structured context for an approval card. `plugin-install` opens the Studio's install review;
 * `proposal` (propose_schema / propose_relationship) links to Explore, where a person confirms it.
 */
export type ApprovalDetail =
  | { kind: "plugin-install"; requestId: string; workspaceId: string }
  | { kind: "proposal"; proposalKind: "mapping" | "relationship"; workspaceId: string }
  /** todo16 D8: a project operation from the catalogue that asks first (big trash, or destroy). */
  | { kind: "operation"; opId: string; tier: "trash" | "destroy"; irreversible: boolean; impact: { items: { kind: string; id: string; name?: string }[]; files?: number } };

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
    /** todo19 D12: the item's data kind id; its profile in the Studio follows from it. */
    kind?: string;
  }[];
  annotations: {
    id: string;
    itemId: string;
    label: string;
    type: string;
    provenance: "human-created" | "ai-suggested" | "human-corrected" | "imported";
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
  | { kind: "select-annotations"; annotationIds: string[]; reason: string }
  /** open_location: a button that opens a project place; the agent never navigates by itself. */
  | { kind: "location"; label: string; target: LocationTarget; reason?: string }
  /** propose_reorganization (todo7 Phase 8): a plan for the project's Files; Apply sends it as the user. */
  | { kind: "reorg-plan"; plan: ReorgPlan }
  /** request_upload (todo16 D10): a drop zone in the chat; the person picks the files, the bytes go the normal import path. */
  | { kind: "upload-request"; reason: string; folderId?: string }
  /** offer_specialist: continue this request with the plugin builder or the code sandbox, on the user's click. */
  | { kind: "specialist"; specialist: "builder" | "coder"; request: string; reason: string };

/**
 * A reorganization plan the assistant proposes for the project's Files (todo7 Phase 8). Ids only
 * for existing nodes, never paths or original names. A new folder gets a `ref` (`new:<handle>`)
 * that later ops use as `parentId`; the web turns the plan into one `fs/ops` batch with fresh
 * `nod-<uuid>` ids, sent as the user after they approve it (the agent's token can't write the
 * namespace), so one undo reverts the whole plan.
 */
export interface ReorgPlan {
  /** Client-made id (`plan-…`): the card, the Files page's `?plan=` and the plan store share it. */
  id: string;
  /** One line, e.g. "Group by patient: 47 folders → patient_001…047". */
  title: string;
  ops: ReorgOp[];
}

export type ReorgOp =
  | { kind: "mkdir"; ref: string; parentId: string; name: string; reason: string }
  | { kind: "move"; nodeIds: string[]; parentId: string; reason: string }
  | { kind: "rename"; nodeId: string; name: string; reason: string };

/** Where open_location points (the same shape as contracts' `ProjectTarget`; ids, never paths). */
export interface LocationTarget {
  section: "overview" | "sources" | "explore" | "datasets" | "studio" | "review" | "activity";
  nodeId?: string;
  proposalId?: string;
  tab?: string;
  taskId?: string;
  datasetId?: string;
}

export type AgentEventBody =
  | { type: "start"; model: string }
  | { type: "run-status"; status: RunStatus }
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool-call"; id: string; name: string; title: string }
  /**
   * Streamed tool arguments (todo11 D4, AG-UI TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END),
   * sent while the model is still writing the call, only for tools whose arguments are worth
   * showing early (`boot_studio`). `delta` is a raw string fragment of the arguments' JSON:
   * concatenate them, never treat one as a parsed object. `tool-call` (execution start) still
   * follows with the same `id`.
   */
  | { type: "tool-call-start"; id: string; name: string }
  | { type: "tool-call-args"; id: string; delta: string }
  | { type: "tool-call-end"; id: string }
  | { type: "tool-progress"; id: string; text: string }
  | { type: "tool-result"; id: string; ok: boolean; summary: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number }
  | { type: "status"; text: string }
  | { type: "client-tool"; callId: string; name: string; input: unknown }
  | { type: "approval"; approvalId: string; toolCallId: string; toolName: string; summary: string; inputPreview: string; expiresAt: number; detail?: ApprovalDetail }
  | { type: "approval-resolved"; approvalId: string; decision: "approve" | "reject" }
  | { type: "sandbox"; state: SandboxState; sandboxId?: string }
  | { type: "artifact"; id: string; name: string; bytes: number; sha256: string }
  | { type: "error"; message: string }
  | { type: "done"; status: RunStatus }
  /** todo21 D4: a chat's list row changed (auto title, rename, run start/finish). */
  | { type: "session.updated"; session: ChatSessionSummary }
  /**
   * Anything with no AG-UI 1.0 equivalent (AG-UI CUSTOM). New run events go here as
   * `{name, value}` rather than as new top-level types; see `ag-ui-map.ts`.
   */
  | { type: "custom"; name: string; value: unknown };

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
  /**
   * A kernel session token the Studio minted for this workspace with the profile's scopes
   * (POST /api/v1/sessions): the project tools (every profile) and the builder / task tools use
   * it. Kept in memory only; refreshed with each message.
   */
  kernelToken?: string;
  /**
   * todo20 W3: the conversation id the browser already uses (`conv-…`) or a known `ses_…` id. The
   * session is created with this id; when it already exists and is the caller's, it is returned
   * as is (idempotent). Omitted: the service picks a `ses_…` id.
   */
  sessionId?: string;
}

/** todo20 W3: one chat of a project (`GET /v1/sessions?projectId=`), newest `updatedAt` first. */
export interface ChatSessionSummary {
  id: string;
  projectId: string;
  /** The first user message, one line, at most ~60 characters; null before the first message. */
  title: string | null;
  createdAt: number;
  updatedAt: number;
  profile: ProfileName;
  /** todo21 D4: who set the title; null while it's still the provisional first-message title. */
  titleBy?: "auto" | "person" | null;
  /** todo21: a run is active in this chat. */
  running?: boolean;
  /** todo21: when the last run finished (ISO), null before the first one. */
  lastRunAt?: string | null;
  /** todo21 D5: the chat this one was branched from (`messageIdx`: the last thread message kept). */
  branchedFrom?: { sessionId: string; messageIdx: number } | null;
}

export interface CreateSessionResponse {
  sessionId: string;
  profile: ProfileName;
  model: string;
  /** todo20 W3: the same row `GET /v1/sessions` lists. */
  session: ChatSessionSummary;
}

/** todo20 W3: a message part of a rebuilt thread; the subset of the web's `MessagePart` the transcript holds. */
export type ThreadPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; title: string; status: "running" | "done" | "error"; summary?: string; input?: unknown; output?: string }
  | { type: "drop"; id: string };

/** todo20 W3: same shape as the web's `ChatMessage` (apps/web/src/studio/stores/agent.ts). */
export interface ThreadMessage {
  id: string;
  role: "user" | "assistant";
  parts: ThreadPart[];
  model?: string;
  runId?: string;
  runStatus?: RunStatus;
  error?: string;
  stopped?: boolean;
  usage?: { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number };
}

/** todo20 W3: `GET /v1/sessions/{id}/thread`. */
export interface ThreadResponse {
  sessionId: string;
  messages: ThreadMessage[];
}

/**
 * A drop on a user message (todo13 D2/D3): files the person dropped, pasted or attached, already
 * uploaded to Files by the browser. The message carries the reference, never bytes; the agent
 * reads the drop's `DropSummary` (screened names, kinds, technical facts) from the kernel.
 */
export interface DropRef {
  dropId: string;
}

/** The drop part of a user message as the agent stores and emits it (`custom` name `drop`). */
export interface DropMessagePart {
  type: "drop";
  dropId: string;
  files: { nodeId: string; agentName: string; kind?: string; state: string }[];
}

export interface SendMessageRequest {
  /** May be empty when the message is a drop alone. */
  text: string;
  /** todo13: files dropped with this message (a drop alone is a message too). */
  drop?: DropRef;
  /** Per-turn state shown to the model with this message, e.g. the `<environment>` block. */
  context?: string;
  /** Dataset snapshot for the dataset tools; replaces the session's previous one. */
  snapshot?: DatasetSnapshot;
  /** A fresh kernel token, replacing the session's previous one. */
  kernelToken?: string;
  /**
   * todo20 W3: create-on-first-use. When the session in the path doesn't exist yet, it is created
   * with that id from these fields (as `POST /v1/sessions` would); ignored when it exists.
   */
  session?: Omit<CreateSessionRequest, "sessionId" | "kernelToken">;
}

export interface SendMessageResponse {
  runId: string;
  /** True when the message was steered into a run that was already active. */
  steered: boolean;
}

/**
 * todo18 D: a reserved browser call (never a model tool). The service asks for it when the
 * delegated kernel token expired mid-run; the browser answers `{ token }`, panel open or not.
 */
export const REFRESH_TOKEN_TOOL = "__refresh_kernel_token";
export type RefreshTokenTool = typeof REFRESH_TOKEN_TOOL;

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
  /** Which sandbox provider the service runs (todo10 §6.2), or off. */
  sandbox: "daytona" | "local" | "gke" | "fake" | "off";
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
