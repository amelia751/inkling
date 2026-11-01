import * as z from "zod";
import { ns } from "../naming";
import { CommitOid, IdempotencyKey, JsonValue, PipelineDigest, PipelineStepId, PortName, ResourceClass, SemverString, ServiceId, StepImplId } from "./common";
import { PipelineErrorEnvelope } from "./errors";
import { PipelineItemState } from "./run";

/**
 * Step I/O (docs/pipeline.md §4, §7.1): what a step declares (its contract), what a kernel job
 * for one step partition receives (`StepInput`, stored at the job's `input_ref`) and what it
 * returns (`StepOutput`, at `result_ref`). Data moves by reference only: an artifact is a blob
 * key plus digest, an item set is a manifest artifact. No sample bytes, names or PHI in here.
 */

/** Port types. The compiler only connects an output to an input of the same type. */
export const PORT_TYPES = ["upload_session", "item_set", "artifact_set", "report", "dataset_commit", "candidate_commit"] as const;
export const PortType = z.enum(PORT_TYPES);
export type PortType = z.infer<typeof PortType>;

export const PortSpec = z
  .object({
    type: PortType,
    required: z.boolean().default(true),
    /** Item kinds the port accepts (`image`, `volume`, …); absent means any. 3D never reaches a 2D-only step. */
    modalities: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)).max(32).optional(),
    description: z.string().max(300).optional(),
  })
  .strict()
  .meta({ id: "PipelinePortSpec" });

/**
 * How a step runs: `builtin` steps are platform operations inside apps/pipeline (validation,
 * proposing the candidate); `kernel_job` steps enqueue a kernel job of `job_kind` and wait for
 * its terminal event (E2).
 */
export const STEP_RUNTIMES = ["builtin", "kernel_job"] as const;

export const StepContract = z
  .object({
    id: StepImplId,
    version: SemverString,
    runtime: z.enum(STEP_RUNTIMES),
    /** Kernel job kind (`POST /api/v1/service/jobs {kind}`), for `kernel_job` steps. */
    job_kind: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).optional(),
    /** The plugin whose signed artifact runs the job, when it isn't a kernel built-in. */
    plugin: StepImplId.optional(),
    description: z.string().max(300),
    inputs: z.record(PortName, PortSpec),
    outputs: z.record(PortName, PortSpec),
    resource_class: ResourceClass.default("cpu"),
    /** May run once per batch of an item set. */
    partitionable: z.boolean().default(false),
    /** Same inputs and parameters always give the same outputs (a precondition for caching, §8). */
    deterministic: z.boolean().default(false),
    default_timeout_seconds: z.number().int().min(1).max(86_400).default(1800),
  })
  .strict()
  .meta({ id: "PipelineStepContract" });
export type StepContract = z.infer<typeof StepContract>;
export type StepContractInput = z.input<typeof StepContract>;

/** An immutable blob in the api's BlobStore, staged under `pipeline/<run>/<step>/<attempt>/…`. */
export const ArtifactRef = z
  .object({
    key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/=-]{0,511}$/),
    digest: PipelineDigest,
    size: z.number().int().nonnegative(),
    media_type: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  })
  .strict()
  .meta({ id: "PipelineArtifactRef" });
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/** A value flowing through a port: always by reference. */
export const PortValue = z
  .object({
    type: PortType,
    /** The manifest listing the set (`item_set`, `artifact_set`), or the report/session document. */
    manifest: ArtifactRef.optional(),
    /** `dataset_commit` / `candidate_commit`. */
    commit: z.object({ repo_id: ServiceId, commit: CommitOid, branch: z.string().max(255).optional() }).strict().optional(),
    /** Upload session id, for `upload_session`. */
    session_id: ServiceId.optional(),
    count: z.number().int().nonnegative().optional(),
  })
  .strict()
  .meta({ id: "PipelinePortValue" });
export type PortValue = z.infer<typeof PortValue>;

/** The document a step partition's kernel job reads (its `input_ref`). */
export const StepInput = z
  .object({
    run_id: ServiceId,
    workspace_id: ServiceId,
    project_id: ServiceId,
    step_id: PipelineStepId,
    partition_id: z.string().regex(/^[0-9]{1,6}$/),
    /** `<run_id>/<step_id>/<partition_id>`: the job's idempotency key. */
    idempotency_key: IdempotencyKey,
    uses: z.string().max(160),
    inputs: z.record(PortName, PortValue),
    params: z.record(z.string().max(63), JsonValue),
    params_digest: PipelineDigest,
    /**
     * `pipeline/<run_id>/<step_id>/`. A job stages under `<output_prefix><partition_id>.<attempt>/`,
     * so every attempt has its own keys and a late worker can't overwrite its replacement's output.
     */
    output_prefix: z.string().regex(/^pipeline\/[A-Za-z0-9_.:-]+\/[a-z][a-z0-9_-]*\/$/),
    /** The item range this partition covers in the fan-out input's manifest. */
    range: z.object({ offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(10_000) }).strict().optional(),
  })
  .strict()
  .meta({ id: "PipelineStepInput" });
export type StepInput = z.infer<typeof StepInput>;

/** Per-item outcome, keyed by kernel ids only (names come from the api, behind its auth). */
export const ItemReport = z
  .object({
    item_id: ServiceId,
    node_id: ServiceId.optional(),
    state: PipelineItemState,
    kind: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
    /** The step that last changed the state. */
    step_id: PipelineStepId.optional(),
    /** Quarantined items stay retryable (§6 partial failure policy). */
    retryable: z.boolean().optional(),
    error: PipelineErrorEnvelope.optional(),
  })
  .strict()
  .meta({ id: "PipelineItemReport" });
export type ItemReport = z.infer<typeof ItemReport>;

/** The document a step partition returns (its `result_ref`). */
export const StepOutput = z
  .object({
    run_id: ServiceId,
    step_id: PipelineStepId,
    partition_id: z.string().regex(/^[0-9]{1,6}$/),
    attempt: z.number().int().min(1),
    outputs: z.record(PortName, PortValue),
    /** Bounded inline; larger reports go in a `report` output's manifest. */
    items: z.array(ItemReport).max(1_000).default([]),
    metrics: z
      .object({ items_in: z.number().int().nonnegative(), items_out: z.number().int().nonnegative(), items_quarantined: z.number().int().nonnegative() })
      .strict()
      .optional(),
    error: PipelineErrorEnvelope.optional(),
  })
  .strict()
  .meta({ id: "PipelineStepOutput" });
export type StepOutput = z.infer<typeof StepOutput>;

/**
 * The platform's own steps, first-party signed. Inspect and derivatives wrap today's kernel
 * import flow (`kernel/inspection.py`, todo11 derivatives); validate and propose run inside
 * apps/pipeline. Plugin steps resolve from the workspace's signed plugin pins instead.
 */
export const BUILTIN_STEP_CONTRACTS: StepContractInput[] = [
  {
    id: ns("ingest.inspect"),
    version: "1.0.0",
    runtime: "kernel_job",
    job_kind: "inspect",
    description: "Fingerprint, unpack and detect the kind of each staged upload; propose items.",
    inputs: { source: { type: "upload_session" } },
    outputs: { items: { type: "item_set" }, report: { type: "report" } },
    resource_class: "cpu",
    deterministic: true,
    default_timeout_seconds: 1800,
  },
  {
    id: ns("ingest.derivatives"),
    version: "1.0.0",
    runtime: "kernel_job",
    job_kind: "derivatives",
    description: "Thumbnails, previews and pyramids for a batch of items (todo11 derivatives).",
    inputs: { items: { type: "item_set" } },
    outputs: { derived: { type: "artifact_set" }, report: { type: "report" } },
    resource_class: "cpu",
    partitionable: true,
    deterministic: true,
    default_timeout_seconds: 1800,
  },
  {
    id: ns("pipeline.validate"),
    version: "1.0.0",
    runtime: "builtin",
    description: "Check every item against the run's policy; split accepted from quarantined.",
    inputs: { items: { type: "item_set" }, derived: { type: "artifact_set", required: false }, report: { type: "report", required: false } },
    outputs: { accepted: { type: "item_set" }, quarantined: { type: "item_set" }, report: { type: "report" } },
    resource_class: "cpu",
    deterministic: true,
    default_timeout_seconds: 600,
  },
  {
    id: ns("pipeline.propose"),
    version: "1.0.0",
    runtime: "builtin",
    description: "Stage the output manifest and create the candidate commit and review in versioning.",
    inputs: { accepted: { type: "item_set" }, derived: { type: "artifact_set", required: false }, report: { type: "report", required: false } },
    outputs: { candidate: { type: "candidate_commit" } },
    resource_class: "cpu",
    default_timeout_seconds: 600,
  },
];

export const BuiltinStepContracts = z.object({ steps: z.array(StepContract) }).strict().meta({ id: "PipelineBuiltinSteps" });
