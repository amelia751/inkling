import * as z from "zod";
import { JsonValue, PipelineDigest, PipelineStepId, PortName, ResourceClass, SemverString, ServiceId, StepImplId } from "./common";
import { ON_FAILURE, PipelineInput, PipelineLimits, PipelinePolicy, PipelineRef } from "./graph";
import { PortType, STEP_RUNTIMES } from "./steps";

/**
 * The frozen execution plan apps/pipeline's compiler produces from a graph (docs/pipeline.md
 * §4): every step resolved to one signed, immutable version, defaults applied, a topological
 * order, and a digest over the RFC 8785 canonical form of everything except `digest` itself.
 * A run pins its plan; nothing about a running pipeline is re-resolved later.
 */
export const PLAN_SCHEMA = "pipeline.plan/v1";

export const ResolvedStep = z
  .object({
    id: StepImplId,
    version: SemverString,
    /** Artifact digest (plugins) or contract digest (platform steps). */
    digest: PipelineDigest,
    /** `first-party` or `<alg>:<keyId>`; `unsigned` never resolves. */
    signer: z.string().min(1).max(256),
  })
  .strict()
  .meta({ id: "PipelineResolvedStep" });

export const PlannedStep = z
  .object({
    id: PipelineStepId,
    uses: z.string().max(160),
    resolved: ResolvedStep,
    runtime: z.enum(STEP_RUNTIMES),
    job_kind: z.string().max(64).optional(),
    plugin: StepImplId.optional(),
    resource_class: ResourceClass,
    needs: z.array(PipelineStepId),
    /** Depth in the DAG: every step at level n depends only on levels < n. */
    level: z.number().int().nonnegative(),
    inputs: z.record(PortName, z.object({ ref: PipelineRef, type: PortType }).strict()),
    outputs: z.record(PortName, PortType),
    params: z.record(z.string(), JsonValue),
    params_digest: PipelineDigest,
    timeout_seconds: z.number().int().min(1),
    max_attempts: z.number().int().min(1),
    fan_out: z.object({ over: PipelineRef, batch_size: z.number().int().min(1), max_partitions: z.number().int().min(1) }).strict().optional(),
    optional: z.boolean(),
    on_failure: z.enum(ON_FAILURE),
  })
  .strict()
  .meta({ id: "PipelinePlannedStep" });

export const ExecutionPlan = z
  .object({
    schema: z.literal(PLAN_SCHEMA),
    definition_id: ServiceId.optional(),
    /** Digest of the canonical graph the plan was compiled from (the revision id). */
    definition_digest: PipelineDigest,
    name: z.string().max(64),
    inputs: z.record(PortName, PipelineInput),
    order: z.array(PipelineStepId),
    steps: z.array(PlannedStep),
    outputs: z.record(PortName, z.object({ ref: PipelineRef, type: PortType }).strict()),
    policy: PipelinePolicy,
    limits: PipelineLimits,
    /** Digest over everything above (RFC 8785). */
    digest: PipelineDigest,
  })
  .strict()
  .meta({ id: "PipelineExecutionPlan" });
export type ExecutionPlan = z.infer<typeof ExecutionPlan>;

/** One compiler finding. `path` is a JSON pointer into the graph. */
export const COMPILE_CODES = [
  "schema",
  "duplicate_step",
  "unknown_step",
  "cycle",
  "unknown_ref",
  "ref_not_upstream",
  "type_mismatch",
  "missing_input",
  "unknown_port",
  "unresolved_step",
  "unsigned_step",
  "modality_mismatch",
  "fan_out_unbounded",
  "fan_out_not_partitionable",
  "limit_exceeded",
  "unknown_output",
] as const;
export const CompileDiagnostic = z
  .object({ code: z.enum(COMPILE_CODES), path: z.string().max(256), message: z.string().max(300) })
  .strict()
  .meta({ id: "PipelineCompileDiagnostic" });

/** `POST /v1/definitions/{id}/validate` → this. */
export const ValidationReport = z
  .object({
    ok: z.boolean(),
    definition_digest: PipelineDigest.optional(),
    plan_digest: PipelineDigest.optional(),
    diagnostics: z.array(CompileDiagnostic).max(200),
  })
  .strict()
  .meta({ id: "PipelineValidationReport" });
export type ValidationReport = z.infer<typeof ValidationReport>;
