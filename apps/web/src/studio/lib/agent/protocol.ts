/**
 * Wire contract between the Inkling AI panel and the agent service (apps/agent).
 *
 * The types come from `@studio/agent-protocol` (packages/agent-protocol, types only), so the panel and the service can't
 * drift. The browser reaches the service through the Vite proxy at /api/agent/* → /v1/*, which
 * adds the service token (vite.config.ts); see apps/agent/README.md for the routes.
 */
export type {
  AgentCard,
  AgentEvent,
  AgentEventBody,
  AgentStatus,
  ApprovalDecisionRequest,
  ApprovalDetail,
  ArtifactInfo,
  ClientToolResultRequest,
  ClientToolSpec,
  CreateSessionRequest,
  CreateSessionResponse,
  DatasetSnapshot as AgentContext,
  ProfileName,
  RunStatus,
  SandboxState,
  SendMessageRequest,
  SendMessageResponse,
  SessionInfo,
} from "@studio/agent-protocol";
