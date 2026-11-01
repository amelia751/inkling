/**
 * Pipeline contracts (docs/pipeline.md; todo/todo12.md §4 Milestone 1 item 1): graph, step I/O,
 * plan, run record, error envelope, reproducibility envelope, events and the private API bodies.
 * Emitted to `schemas/pipeline/*.v1.json`; apps/pipeline (Go) validates against those files.
 */
import * as z from "zod";
import { CancelRunRequest, ApprovalRequest, CreateRunRequest, ValidateDefinitionRequest } from "./api";
import { ReproducibilityEnvelope } from "./envelope";
import { PipelineErrorEnvelope } from "./errors";
import { PipelineEvent } from "./events";
import { PipelineGraph } from "./graph";
import { INGEST_PIPELINE } from "./ingest";
import { ExecutionPlan, ValidationReport } from "./plan";
import { PipelineRunRecord } from "./run";
import { BUILTIN_STEP_CONTRACTS, BuiltinStepContracts, StepContract, StepInput, StepOutput } from "./steps";

export * from "./common";
export * from "./graph";
export * from "./steps";
export * from "./errors";
export * from "./run";
export * from "./envelope";
export * from "./events";
export * from "./plan";
export * from "./api";
export * from "./ingest";

/** Every pipeline JSON Schema by its emitted path under `schemas/` (`$id` suffix = path without `.json`). */
export const PIPELINE_SCHEMAS: Record<string, z.ZodType> = {
  "pipeline/graph.v1.json": PipelineGraph,
  "pipeline/plan.v1.json": ExecutionPlan,
  "pipeline/step-contract.v1.json": StepContract,
  "pipeline/step-input.v1.json": StepInput,
  "pipeline/step-output.v1.json": StepOutput,
  "pipeline/run.v1.json": PipelineRunRecord,
  "pipeline/error.v1.json": PipelineErrorEnvelope,
  "pipeline/reproducibility.v1.json": ReproducibilityEnvelope,
  "pipeline/event.v1.json": PipelineEvent,
  "pipeline/create-run.v1.json": CreateRunRequest,
  "pipeline/cancel-run.v1.json": CancelRunRequest,
  "pipeline/approval.v1.json": ApprovalRequest,
  "pipeline/validate-definition.v1.json": ValidateDefinitionRequest,
  "pipeline/validation-report.v1.json": ValidationReport,
};

/**
 * Generated data documents (not schemas), by path under `schemas/`: the platform's step
 * contracts, and the implicit ingest definition at `registry/pipelines/ingest.json`.
 */
export function pipelineDocuments(): Record<string, unknown> {
  return {
    "pipeline/builtin-steps.v1.json": BuiltinStepContracts.parse({ steps: BUILTIN_STEP_CONTRACTS }),
    "../registry/pipelines/ingest.json": INGEST_PIPELINE,
  };
}
