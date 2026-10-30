/**
 * Wire contract between the Inkling AI panel and the agent runtime
 * (`dev/agent-server.ts` in dev; the FastAPI backend later).
 *
 * POST /api/agent/chat with a ChatRequest; the response is a Server-Sent Events
 * stream of AgentEvents (`data: <json>\n\n`). GET /api/agent/status reports
 * whether a model is configured.
 */

/**
 * What the panel shares with the model: text only. Never pixels, files or
 * DICOM headers; item names are the dataset's own de-identified ids.
 */
export interface AgentContext {
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
  items: { id: string; name: string; group: string; sourceLabel?: string }[];
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

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatTurn[];
  context: AgentContext;
}

export interface AgentStatus {
  configured: boolean;
  provider: string;
  model: string | null;
}

/** Structured output the panel renders as an interactive card. */
export type AgentCard =
  | { kind: "items"; title: string; itemIds: string[] }
  | { kind: "label-schema"; title: string; labels: { name: string; description: string; color?: string }[] }
  | { kind: "document"; title: string; filename: string; markdown: string }
  | { kind: "tool-switch"; tool: string; label?: string; reason: string }
  | { kind: "review-suggestions"; action: "accept" | "reject"; annotationIds: string[]; reason: string }
  | { kind: "select-annotations"; annotationIds: string[]; reason: string };

export type AgentEvent =
  | { type: "start"; model: string }
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool-call"; id: string; name: string; title: string }
  | { type: "tool-result"; id: string; ok: boolean; summary: string; input: unknown; card?: AgentCard }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string }
  | { type: "done" };
