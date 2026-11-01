import type { AgentEventBody } from "./index.ts";

/**
 * How each run event maps onto AG-UI 1.0 (todo11 D4). Data only: a future
 * `GET /v1/runs/:id/events?format=ag-ui` translates with it on the server, and
 * `test/ag-ui-map.test.ts` checks it against the vendored schema
 * (`fixtures/ag-ui-1.0.schema.json`, from https://docs.ag-ui.com/spec/1.0/schema.json; the same
 * `EventType` enum as `@ag-ui/core@1.0.3`).
 *
 * Rules for new run events:
 * - match an AG-UI 1.0 event's meaning, with an AG-UI-style name;
 * - anything with no equivalent goes in the one `custom {name, value}` envelope (AG-UI CUSTOM),
 *   not as a new top-level type.
 * An event type missing here fails `tsc` (the `satisfies` below) and the unit test.
 */

/** AG-UI 1.0 `EventType` values this table may name. */
export type AgUiEventType =
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_END"
  | "TEXT_MESSAGE_CHUNK"
  | "TOOL_CALL_START"
  | "TOOL_CALL_ARGS"
  | "TOOL_CALL_END"
  | "TOOL_CALL_CHUNK"
  | "TOOL_CALL_RESULT"
  | "STATE_SNAPSHOT"
  | "STATE_DELTA"
  | "MESSAGES_SNAPSHOT"
  | "ACTIVITY_SNAPSHOT"
  | "ACTIVITY_DELTA"
  | "RAW"
  | "CUSTOM"
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "STEP_STARTED"
  | "STEP_FINISHED"
  | "REASONING_START"
  | "REASONING_MESSAGE_START"
  | "REASONING_MESSAGE_CONTENT"
  | "REASONING_MESSAGE_END"
  | "REASONING_MESSAGE_CHUNK"
  | "REASONING_END"
  | "REASONING_ENCRYPTED_VALUE"
  | "SUBAGENT_STARTED"
  | "SUBAGENT_FINISHED"
  | "SUBAGENT_ERROR";

export interface AgUiMapping {
  /** The AG-UI event(s) one of ours becomes, in emission order. */
  targets: readonly AgUiEventType[];
  /** For CUSTOM: the `name` it carries (`custom` itself passes its own name through). */
  customName?: string;
  /** Translation details a server-side mapper needs. */
  note?: string;
}

export const AG_UI_MAP = {
  start: { targets: ["RUN_STARTED"] },
  text: { targets: ["TEXT_MESSAGE_CONTENT"], note: "TEXT_MESSAGE_START / TEXT_MESSAGE_END are implied at message boundaries" },
  reasoning: { targets: ["REASONING_MESSAGE_CONTENT"], note: "REASONING_START / REASONING_MESSAGE_START / _END / REASONING_END are implied at boundaries" },
  "tool-call-start": { targets: ["TOOL_CALL_START"] },
  "tool-call-args": { targets: ["TOOL_CALL_ARGS"], note: "delta is a string fragment of the arguments' JSON" },
  "tool-call-end": { targets: ["TOOL_CALL_END"] },
  "tool-call": { targets: ["TOOL_CALL_START"], note: "skipped when tool-call-start already opened this id" },
  "tool-result": { targets: ["TOOL_CALL_END", "TOOL_CALL_RESULT"], note: "TOOL_CALL_END is skipped when tool-call-end already closed this id" },
  "tool-progress": { targets: ["ACTIVITY_DELTA"] },
  status: { targets: ["ACTIVITY_SNAPSHOT"] },
  error: { targets: ["RUN_ERROR"] },
  done: { targets: ["RUN_FINISHED"], note: "RUN_ERROR instead when status is failed" },
  "run-status": { targets: ["CUSTOM"], customName: "run-status" },
  usage: { targets: ["CUSTOM"], customName: "usage" },
  "client-tool": { targets: ["CUSTOM"], customName: "client-tool" },
  approval: { targets: ["CUSTOM"], customName: "approval" },
  "approval-resolved": { targets: ["CUSTOM"], customName: "approval-resolved" },
  sandbox: { targets: ["CUSTOM"], customName: "sandbox" },
  artifact: { targets: ["CUSTOM"], customName: "artifact" },
  custom: { targets: ["CUSTOM"], note: "name and value pass through" },
} as const satisfies Record<AgentEventBody["type"], AgUiMapping>;
