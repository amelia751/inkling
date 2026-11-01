import * as z from "zod";
import { CommitOid, PipelineDigest, PipelineStepId, ServiceId, Timestamp } from "./common";

/**
 * The reproducibility envelope (docs/pipeline.md §3): everything a run pinned when it started.
 * Two runs with equal envelopes interpret their inputs identically. Digests and ids only; no
 * credentials, PHI or inline manifests.
 */
export const ReproducibilityEnvelope = z
  .object({
    run_id: ServiceId,
    workspace_id: ServiceId,
    definition_id: ServiceId,
    definition_revision: PipelineDigest,
    plan_digest: PipelineDigest,
    input_dataset_commits: z
      .array(z.object({ repo_id: ServiceId, commit: CommitOid, schema_id: ServiceId.optional() }).strict())
      .max(64)
      .default([]),
    /** Pinned upload sessions: id and the digest of their immutable session manifest. */
    input_sources: z.array(z.object({ session_id: ServiceId, manifest_digest: PipelineDigest }).strict()).max(64).default([]),
    /** step id → `<impl id>@<exact version>`. */
    resolved_step_versions: z.record(PipelineStepId, z.string().max(160)),
    code_artifact_digests: z.record(PipelineStepId, PipelineDigest).default({}),
    container_image_digests: z.record(PipelineStepId, PipelineDigest).default({}),
    parameters_digest: PipelineDigest,
    execution_policy_version: z.string().regex(/^[a-z0-9_.-]{1,32}$/),
    engine: z.enum(["dbos"]),
    /** DBOS `ApplicationVersion`: the workflow package digest of the build that started the run. */
    application_version: z.string().max(80),
    created_at: Timestamp,
  })
  .strict()
  .meta({ id: "PipelineReproducibilityEnvelope" });
export type ReproducibilityEnvelope = z.infer<typeof ReproducibilityEnvelope>;
