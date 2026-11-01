/**
 * Wire shapes of the pipeline gateway routes and events (docs/pipeline.md §3, §5, §6, §15) as
 * the web reads them. The one place to swap for the zod contracts in
 * `packages/contracts/src/pipeline/` once they land: everything else in this folder imports
 * these names only. Fields the page can live without are optional, so an older or newer
 * server degrades to "—" rather than a crash. Snake case, like the event envelope (P§15).
 */

/** Run lifecycle (todo12 §5): queued → running → awaiting_review → publishing → published | rejected | failed | cancelled. */
export const RUN_STATES = ["queued", "running", "awaiting_review", "publishing", "published", "rejected", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Item lifecycle, extending todo11's `item.*`: discovered → staged → validated | quarantined → processed → proposed | rejected. */
export const ITEM_STATES = ["discovered", "staged", "validated", "quarantined", "processed", "proposed", "rejected"] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/** One logical step's state (its attempts are subordinate, P§16). */
export const STEP_STATES = ["pending", "running", "succeeded", "failed", "skipped", "cancelled"] as const;
export type StepState = (typeof STEP_STATES)[number];

/** What started the run. Uploads start the implicit ingest pipeline (P§6). */
export interface RunTrigger {
  kind: "upload" | "manual" | "connector" | "schedule" | "backfill";
  /** The import session (`/projects/:id/imports/:importId`) for an upload. */
  import_id?: string | null;
  /** `user:<id>`, `agent:<id>` or `service:<name>`. */
  actor?: string | null;
}

export interface ErrorEnvelope {
  /** Stable class (`validation`, `timeout`, `worker_lost`, `stale_head`…). */
  class: string;
  /** Plain words, no PHI. */
  message: string;
  retryable?: boolean;
}

/** `GET /api/v1/projects/{id}/pipeline-runs` rows. */
export interface PipelineRunSummary {
  run_id: string;
  workspace_id?: string;
  project_id: string;
  definition_id: string;
  /** Display name of the definition ("Ingest"); falls back to `definition_id`. */
  definition_name?: string | null;
  /** `sha256:…` of the frozen plan. */
  definition_revision?: string | null;
  state: RunState;
  trigger?: RunTrigger | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  /** Items by state; absent states are 0. */
  item_counts?: Partial<Record<ItemState, number>>;
  /** All items the run saw (sum of `item_counts` when absent). */
  item_total?: number | null;
  error?: ErrorEnvelope | null;
}

export interface RunsPage {
  runs: PipelineRunSummary[];
  next_cursor?: string | null;
}

export interface StepExecution {
  step_id: string;
  /** "Inspect", "Thumbnails"… (falls back to `step_id`). */
  label?: string | null;
  /** Resolved plugin version, `plugin.inspect@1.2.0` (the reproducibility envelope). */
  plugin?: string | null;
  state: StepState;
  attempts?: number;
  max_attempts?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  items_in?: number | null;
  items_out?: number | null;
  error?: ErrorEnvelope | null;
}

/** One file's diagnostic (P§6 step 6). */
export interface Diagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  step_id?: string | null;
}

/** One row of the per-file report. */
export interface ItemReport {
  item_id: string;
  /** Path inside the upload, as provenance. Shown to members like the Imports list does; never put in a URL. */
  rel_path: string;
  /** The file's node in Files, when it has one. */
  node_id?: string | null;
  size?: number | null;
  kind?: string | null;
  state: ItemState;
  /** The step that last changed the state. */
  step_id?: string | null;
  /** Short reason for quarantine or rejection. */
  reason?: string | null;
  diagnostics?: Diagnostic[];
  /** Quarantined items stay retryable (P§6 partial failure policy). */
  retryable?: boolean;
}

/** The unpromoted output (P§3 `CandidateCommit`), on branch `pipeline/<run_id>`. */
export interface Candidate {
  dataset_id: string;
  branch: string;
  commit: string;
  /** What an approval is bound to (P§13). */
  output_manifest_digest: string;
  created_at?: string | null;
  item_count?: number | null;
}

export interface RunReview {
  review_id: string;
  /** Versioning's review status (OPEN, READY, MERGED, CLOSED…). */
  status: string;
  /** Server-decided: the caller may approve this candidate (a reviewer, not its author). */
  can_approve: boolean;
  approved_by?: string | null;
  approved_at?: string | null;
}

/** `GET /api/v1/pipeline-runs/{id}`. */
export interface PipelineRun extends PipelineRunSummary {
  steps: StepExecution[];
  items: ItemReport[];
  /** More items than `items` carries (large runs page the report). */
  items_truncated?: boolean;
  candidate?: Candidate | null;
  review?: RunReview | null;
  /** Reproducibility envelope (P§3), shown in small print. */
  resolved_step_versions?: Record<string, string> | null;
}

/** `POST /api/v1/pipeline-runs/{id}/approve` body. */
export interface ApproveRequest {
  candidate_digest: string;
}

/** Its answer: the approval (its id is the PublishWorkflow's id) and the run, if the server sends it. */
export interface ApproveResponse {
  approval_id: string;
  state?: RunState;
  run?: PipelineRun;
}

/** Project SSE event types this view follows (P§15, todo12 §4 `todo12-kernel`). */
export const PIPELINE_EVENTS = [
  "pipeline.run.started",
  "pipeline.run.completed",
  "pipeline.run.failed",
  "pipeline.run.paused",
  "pipeline.step.started",
  "pipeline.step.completed",
  "pipeline.step.failed",
  "pipeline.output.staged",
  "dataset.candidate.created",
  "review.requested",
  "review.approved",
] as const;
export type PipelineEventType = (typeof PIPELINE_EVENTS)[number];

/** An event's `payload` (the SSE `data`). Large values go by `payload_ref`, never inline. */
export interface PipelineEventPayload {
  project_id?: string;
  run_id?: string;
  state?: RunState;
  step_id?: string;
  step_state?: StepState;
  attempt?: number;
  candidate_commit?: string;
  output_manifest_digest?: string;
  review_id?: string;
  error_class?: string;
}
