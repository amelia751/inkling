import * as z from "zod";
import { CommitOid, IdempotencyKey, PipelineDigest, PipelineStepId, ServiceId, Timestamp } from "./common";
import { ReproducibilityEnvelope } from "./envelope";
import { PipelineErrorEnvelope } from "./errors";

/**
 * Run, step and item state (todo/todo12.md §5 contracts; names fixed, change through the
 * integrator). A run never waits for a human: it ends at `awaiting_review`, and an approval
 * starts a separate publish (docs/pipeline.md §5.2).
 */
export const PIPELINE_RUN_STATES = ["queued", "running", "awaiting_review", "publishing", "published", "rejected", "failed", "cancelled"] as const;
export const PipelineRunState = z.enum(PIPELINE_RUN_STATES);
export type PipelineRunState = z.infer<typeof PipelineRunState>;

/** Allowed run transitions. `publishing → awaiting_review` is a stale head: a rebase review opens. */
export const PIPELINE_RUN_TRANSITIONS: Record<PipelineRunState, readonly PipelineRunState[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["awaiting_review", "publishing", "failed", "cancelled"],
  awaiting_review: ["publishing", "rejected", "cancelled"],
  publishing: ["published", "awaiting_review", "failed"],
  published: [],
  rejected: [],
  failed: [],
  cancelled: [],
};
export const TERMINAL_RUN_STATES: readonly PipelineRunState[] = ["published", "rejected", "failed", "cancelled"];

/** Item lifecycle, extending todo11's `item.*`. */
export const PIPELINE_ITEM_STATES = ["discovered", "staged", "validated", "quarantined", "processed", "proposed", "rejected"] as const;
export const PipelineItemState = z.enum(PIPELINE_ITEM_STATES);
export type PipelineItemState = z.infer<typeof PipelineItemState>;

export const PIPELINE_STEP_STATES = ["pending", "running", "succeeded", "failed", "skipped", "cancelled"] as const;
export const PipelineStepState = z.enum(PIPELINE_STEP_STATES);
export type PipelineStepState = z.infer<typeof PipelineStepState>;

export const PipelineStepExecution = z
  .object({
    step_id: PipelineStepId,
    partition_id: z.string().regex(/^[0-9]{1,6}$/),
    /** Display label ("Inspect"); the web falls back to `step_id`. */
    label: z.string().max(80).optional(),
    /** Resolved implementation, `<id>@<exact version>` (from the reproducibility envelope). */
    plugin: z.string().max(160).optional(),
    state: PipelineStepState,
    attempts: z.number().int().nonnegative(),
    max_attempts: z.number().int().min(1).optional(),
    job_id: ServiceId.optional(),
    started_at: Timestamp.optional(),
    finished_at: Timestamp.optional(),
    items_in: z.number().int().nonnegative().optional(),
    items_out: z.number().int().nonnegative().optional(),
    items_quarantined: z.number().int().nonnegative().optional(),
    error: PipelineErrorEnvelope.optional(),
  })
  .strict()
  .meta({ id: "PipelineStepExecution" });
export type PipelineStepExecution = z.infer<typeof PipelineStepExecution>;

/** The candidate a run proposed: a commit on `pipeline/<run_id>` and its review. */
export const PipelineCandidate = z
  .object({
    repo_id: ServiceId,
    branch: z.string().regex(/^pipeline\/[A-Za-z0-9_.-]{1,128}$/),
    target_branch: z.string().max(255),
    commit: CommitOid,
    /** The target head the candidate was built against (`expected_head` at publish). */
    base_commit: CommitOid,
    review_id: ServiceId,
    /** Digest of the staged output manifest; approvals bind to it (P§13, P§15). */
    output_manifest_digest: PipelineDigest,
    item_count: z.number().int().nonnegative().optional(),
    created_at: Timestamp.optional(),
  })
  .strict()
  .meta({ id: "PipelineCandidate" });
export type PipelineCandidate = z.infer<typeof PipelineCandidate>;

export const PipelineRunRecord = z
  .object({
    run_id: ServiceId,
    workspace_id: ServiceId,
    project_id: ServiceId,
    definition_id: ServiceId,
    definition_name: z.string().max(80).optional(),
    definition_revision: PipelineDigest,
    plan_digest: PipelineDigest,
    state: PipelineRunState,
    trigger: z
      .object({
        type: z.string().max(64),
        source_event_id: ServiceId.optional(),
        idempotency_key: IdempotencyKey,
        /** The import session, for uploads. */
        import_id: ServiceId.optional(),
        /** `user:<id>`, `agent:<id>` or `service:<name>`. */
        actor: z.string().max(160).optional(),
      })
      .strict(),
    envelope: ReproducibilityEnvelope,
    steps: z.array(PipelineStepExecution).max(10_000),
    candidate: PipelineCandidate.optional(),
    publish: z
      .object({ approval_id: ServiceId, merge_commit: CommitOid.optional(), rebase_review_id: ServiceId.optional() })
      .strict()
      .optional(),
    /** Items by state across the run; absent states are 0. */
    item_counts: z.partialRecord(PipelineItemState, z.number().int().nonnegative()).optional(),
    item_total: z.number().int().nonnegative().optional(),
    error: PipelineErrorEnvelope.optional(),
    created_at: Timestamp,
    started_at: Timestamp.optional(),
    finished_at: Timestamp.optional(),
    updated_at: Timestamp,
    deadline_at: Timestamp,
  })
  .strict()
  .meta({ id: "PipelineRunRecord" });
export type PipelineRunRecord = z.infer<typeof PipelineRunRecord>;
