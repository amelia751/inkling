import * as z from "zod";
import { CommitOid, IdempotencyKey, PipelineDigest, PortName, ServiceId } from "./common";
import { PipelineGraph } from "./graph";

/**
 * Bodies of the private pipeline API (todo/todo12.md §5 contracts), called only by apps/api
 * with a JWT it signs (kid `api`):
 *   POST /v1/runs                       CreateRunRequest → PipelineRunRecord
 *   GET  /v1/runs/{id}                  → PipelineRunRecord
 *   POST /v1/runs/{id}/cancel           CancelRunRequest → PipelineRunRecord
 *   POST /v1/approvals                  ApprovalRequest → PipelineRunRecord
 *   POST /v1/definitions/{id}/validate  ValidateDefinitionRequest → ValidationReport
 */

/** What each graph input is bound to for this run; the run pins these at start. */
export const RunInputBinding = z
  .object({
    session_id: ServiceId.optional(),
    session_manifest_digest: PipelineDigest.optional(),
    repo_id: ServiceId.optional(),
    commit: CommitOid.optional(),
  })
  .strict()
  .meta({ id: "PipelineRunInputBinding" });

export const CreateRunRequest = z
  .object({
    workspace_id: ServiceId,
    project_id: ServiceId,
    definition_id: ServiceId,
    /** A specific revision; absent means the definition's current one, pinned now. */
    revision: PipelineDigest.optional(),
    inputs: z.record(PortName, RunInputBinding),
    /** The dataset the candidate is proposed to: versioning repo and target branch. */
    target: z.object({ repo_id: ServiceId, branch: z.string().min(1).max(255) }).strict(),
    trigger: z.object({ type: z.string().max(64), source_event_id: ServiceId.optional() }).strict(),
    /** Unique per workspace; a repeat returns the same run. */
    idempotency_key: IdempotencyKey,
    actor: ServiceId,
    correlation_id: z.string().max(128).optional(),
  })
  .strict()
  .meta({ id: "PipelineCreateRunRequest" });
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const CancelRunRequest = z.object({ actor: ServiceId, reason: z.string().max(200).optional() }).strict().meta({ id: "PipelineCancelRunRequest" });

/**
 * An approval apps/api recorded in versioning, bound to the candidate's digest. Starts
 * `PublishWorkflow` with workflow id = `approval_id`, so a repeated approval publishes once.
 */
export const ApprovalRequest = z
  .object({ run_id: ServiceId, approval_id: ServiceId, candidate_digest: PipelineDigest })
  .strict()
  .meta({ id: "PipelineApprovalRequest" });
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const ValidateDefinitionRequest = z.object({ graph: PipelineGraph }).strict().meta({ id: "PipelineValidateDefinitionRequest" });
