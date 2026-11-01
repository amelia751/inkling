import * as z from "zod";
import { PipelineStepId, ServiceId } from "./common";

/**
 * The pipeline error envelope (docs/pipeline.md §12). Classes decide retries; `code` is a
 * stable machine slug; `message` is fixed platform text, never an exception string or a sample
 * value (diagnostics shown to the agent follow todo10: no raw exception text, small counts
 * suppressed).
 */
export const PIPELINE_ERROR_CLASSES = [
  "transient",
  "rate_limited",
  "worker_crash",
  "invalid_input",
  "schema_incompatible",
  "user_code_error",
  "policy_denied",
  "resource_exceeded",
  "permanent_dependency",
  "approval_timeout",
  "cancelled",
  "deadline_exceeded",
] as const;
export const PipelineErrorClass = z.enum(PIPELINE_ERROR_CLASSES);
export type PipelineErrorClass = z.infer<typeof PipelineErrorClass>;

/** Classes worth another attempt; everything else quarantines or fails at once. */
export const RETRYABLE_ERROR_CLASSES: readonly PipelineErrorClass[] = ["transient", "rate_limited", "worker_crash"];

export const PipelineErrorEnvelope = z
  .object({
    class: PipelineErrorClass,
    code: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
    /** Platform-authored, fixed wording. */
    message: z.string().max(300),
    retryable: z.boolean(),
    step_id: PipelineStepId.optional(),
    partition_id: z.string().regex(/^[0-9]{1,6}$/).optional(),
    attempt: z.number().int().min(1).optional(),
    job_id: ServiceId.optional(),
  })
  .strict()
  .meta({ id: "PipelineErrorEnvelope" });
export type PipelineErrorEnvelope = z.infer<typeof PipelineErrorEnvelope>;
