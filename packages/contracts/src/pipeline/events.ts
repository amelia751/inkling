import * as z from "zod";
import { CommitOid, IdempotencyKey, PipelineDigest, PipelineStepId, ServiceId } from "./common";
import { PipelineErrorClass } from "./errors";
import { PipelineRunState } from "./run";
import { ArtifactRef } from "./steps";

/**
 * Pipeline events (docs/pipeline.md §15; todo/todo12.md §5): the kernel outbox envelope
 * (`plugin_events` columns) with `source = "pipeline"` and
 * `idempotency_key = <run_id>/<event>[/<step_id>]`. Registered in `kernel/events.py`;
 * project-scoped ones (every one here) flow to the project SSE stream. No PHI in payloads.
 */
export const PIPELINE_EVENT_TYPES = [
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
export type PipelineEventType = (typeof PIPELINE_EVENT_TYPES)[number];
export const PIPELINE_EVENT_SOURCE = "pipeline";

const RunBase = { project_id: ServiceId, run_id: ServiceId };
const StepBase = { ...RunBase, step_id: PipelineStepId, partition_id: z.string().regex(/^[0-9]{1,6}$/).optional(), attempt: z.number().int().min(1).optional() };

export const PIPELINE_EVENT_PAYLOADS = {
  "pipeline.run.started": z.object({ ...RunBase, definition_id: ServiceId, definition_revision: PipelineDigest, plan_digest: PipelineDigest }).strict(),
  "pipeline.run.completed": z
    .object({ ...RunBase, state: PipelineRunState, output_manifest_digest: PipelineDigest.optional(), candidate_commit: CommitOid.optional(), merge_commit: CommitOid.optional() })
    .strict(),
  "pipeline.run.failed": z.object({ ...RunBase, error_class: PipelineErrorClass, code: z.string().max(64), step_id: PipelineStepId.optional() }).strict(),
  /** The run reached `awaiting_review` (no workflow is waiting) or was held by policy. */
  "pipeline.run.paused": z.object({ ...RunBase, reason: z.enum(["awaiting_review", "stale_head", "policy"]) }).strict(),
  "pipeline.step.started": z.object({ ...StepBase, job_id: ServiceId.optional() }).strict(),
  "pipeline.step.completed": z
    .object({ ...StepBase, items_out: z.number().int().nonnegative().optional(), items_quarantined: z.number().int().nonnegative().optional() })
    .strict(),
  "pipeline.step.failed": z.object({ ...StepBase, error_class: PipelineErrorClass, code: z.string().max(64) }).strict(),
  "pipeline.output.staged": z.object({ ...RunBase, step_id: PipelineStepId, manifest: ArtifactRef }).strict(),
  "dataset.candidate.created": z
    .object({ ...RunBase, repo_id: ServiceId, branch: z.string().max(255), candidate_commit: CommitOid, output_manifest_digest: PipelineDigest })
    .strict(),
  "review.requested": z.object({ ...RunBase, repo_id: ServiceId, review_id: ServiceId, candidate_commit: CommitOid, candidate_digest: PipelineDigest }).strict(),
  "review.approved": z.object({ ...RunBase, review_id: ServiceId, approval_id: ServiceId, candidate_digest: PipelineDigest }).strict(),
} as const satisfies Record<PipelineEventType, z.ZodType>;

const envelope = <T extends PipelineEventType>(type: T) =>
  z
    .object({
      event_id: ServiceId,
      workspace_id: ServiceId,
      type: z.literal(type),
      source: z.literal(PIPELINE_EVENT_SOURCE),
      correlation_id: z.string().max(128).optional(),
      /** Trigger-loop guard (§14). */
      depth: z.number().int().min(0).max(16),
      idempotency_key: IdempotencyKey,
      payload: PIPELINE_EVENT_PAYLOADS[type],
      payload_ref: z.string().max(512).optional(),
    })
    .strict();

export const PipelineEvent = z
  .discriminatedUnion(
    "type",
    PIPELINE_EVENT_TYPES.map((t) => envelope(t)) as unknown as [ReturnType<typeof envelope<"pipeline.run.started">>, ...ReturnType<typeof envelope<PipelineEventType>>[]],
  )
  .meta({ id: "PipelineEvent" });
export type PipelineEvent = { [T in PipelineEventType]: Omit<z.infer<ReturnType<typeof envelope<T>>>, "payload"> & { type: T; payload: z.infer<(typeof PIPELINE_EVENT_PAYLOADS)[T]> } }[PipelineEventType];

/** `<run_id>/<event>[/<step_id>[/<partition_id>]]`: the event's idempotency key. */
export const pipelineEventKey = (runId: string, type: PipelineEventType, stepId?: string, partitionId?: string) =>
  [runId, type, stepId, partitionId].filter((x) => x !== undefined).join("/");
