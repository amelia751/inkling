import * as z from "zod";
import { NS } from "../naming";
import { JsonValue, PipelineStepId, PortName, ResourceClass } from "./common";

/**
 * The declarative pipeline graph (docs/pipeline.md §4): one document the UI, the agent and the
 * API all author, compiled by apps/pipeline (`internal/compiler`) into a frozen execution plan.
 * The engine is an executor, never the definition format.
 *
 * References are explicit strings, not expressions: `${inputs.<name>}` or
 * `${steps.<id>.outputs.<port>}`. The compiler checks every reference, the DAG (no cycles,
 * every `needs` known), port types against the resolved step contracts, and the fan-out bounds.
 */

/** `<namespace>.dev/v1`, from the naming config. */
export const PIPELINE_API_VERSION = `${NS}.dev/v1`;
export const PIPELINE_KIND = "Pipeline";

/** `<step implementation id>@<major>`: the compiler resolves it to one signed, immutable version. */
export const StepUses = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+@[0-9]{1,4}$/, "<id>@<major>");
export const InputRef = z.string().regex(/^\$\{inputs\.[a-z][a-z0-9_]{0,62}\}$/, "${inputs.<name>}");
export const StepOutputRef = z.string().regex(/^\$\{steps\.[a-z][a-z0-9_-]{0,62}\.outputs\.[a-z][a-z0-9_]{0,62}\}$/, "${steps.<id>.outputs.<port>}");
export const PipelineRef = z.union([InputRef, StepOutputRef]);
export type PipelineRef = z.infer<typeof PipelineRef>;

/** What a pipeline input is. Runs pin each one when they start (docs/pipeline.md §3). */
export const PIPELINE_INPUT_TYPES = ["upload_session", "dataset", "artifact_set"] as const;
export const PipelineInput = z
  .object({
    type: z.enum(PIPELINE_INPUT_TYPES),
    description: z.string().max(500).optional(),
    /** For `dataset`: which repository and branch to pin at run start. */
    selector: z
      .object({ repository: z.string().max(128).optional(), branch: z.string().max(255).optional() })
      .strict()
      .optional(),
    pin_at_run_start: z.boolean().default(true),
  })
  .strict()
  .meta({ id: "PipelineInput" });

export const PIPELINE_TRIGGER_TYPES = ["manual", "upload.completed", "dataset.commit", "schedule"] as const;
export const PipelineTrigger = z
  .object({
    type: z.enum(PIPELINE_TRIGGER_TYPES),
    branch: z.string().max(255).optional(),
    /** Five-field cron, for `schedule`. */
    cron: z.string().regex(/^[0-9*,/ -]{9,64}$/).optional(),
  })
  .strict()
  .meta({ id: "PipelineTrigger" });

export const EXECUTION_CLASSES = ["builtin", "trusted-python", "gpu"] as const;
export const ON_FAILURE = ["fail", "skip", "quarantine"] as const;

export const PipelineStep = z
  .object({
    id: PipelineStepId,
    uses: StepUses,
    description: z.string().max(500).optional(),
    needs: z.array(PipelineStepId).max(64).default([]),
    inputs: z.record(PortName, PipelineRef).default({}),
    /** Step parameters; their digest is part of the reproducibility envelope. */
    with: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), JsonValue).default({}),
    execution: z
      .object({
        class: z.enum(EXECUTION_CLASSES).optional(),
        timeout_seconds: z.number().int().min(1).max(86_400).optional(),
        /** Kernel `max_attempts` for this step's jobs; the kernel is the only retry owner (E2). */
        max_attempts: z.number().int().min(1).max(10).optional(),
      })
      .strict()
      .optional(),
    resources: z
      .object({
        class: ResourceClass.optional(),
        gpu: z.number().int().min(0).max(8).optional(),
        memory_gb: z.number().int().min(1).max(512).optional(),
      })
      .strict()
      .optional(),
    /** Run the step once per bounded batch of an item set, never once per item. */
    fan_out: z
      .object({
        over: PipelineRef,
        batch_size: z.number().int().min(1).max(10_000),
        max_partitions: z.number().int().min(1).max(10_000),
      })
      .strict()
      .optional(),
    optional: z.boolean().default(false),
    on_failure: z.enum(ON_FAILURE).default("fail"),
  })
  .strict()
  .meta({ id: "PipelineStep" });
export type PipelineStep = z.infer<typeof PipelineStep>;

export const COMPATIBILITY_MODES = ["strict", "compatible", "adaptive"] as const;
export const PipelinePolicy = z
  .object({
    /** `required`: the run ends at `awaiting_review`; an approval starts the publish (E3). */
    review: z.enum(["required", "auto"]).default("required"),
    partial_success: z
      .object({ allowed: z.boolean().default(false), min_success_ratio: z.number().min(0).max(1).default(1) })
      .strict()
      .default({ allowed: false, min_success_ratio: 1 }),
    /** Hard run deadline, within the platform maximum of 24 h. */
    deadline_seconds: z.number().int().min(60).max(86_400).default(86_400),
    compatibility: z.enum(COMPATIBILITY_MODES).default("compatible"),
  })
  .strict()
  .meta({ id: "PipelinePolicy" });

/** Bounds the compiler enforces; a graph can lower them, never raise them past the maximums. */
export const PIPELINE_LIMITS = { max_steps: 256, max_partitions_per_step: 10_000, max_total_partitions: 100_000 } as const;
export const PipelineLimits = z
  .object({
    max_steps: z.number().int().min(1).max(PIPELINE_LIMITS.max_steps).default(64),
    max_partitions_per_step: z.number().int().min(1).max(PIPELINE_LIMITS.max_partitions_per_step).default(1_000),
    max_total_partitions: z.number().int().min(1).max(PIPELINE_LIMITS.max_total_partitions).default(10_000),
  })
  .strict()
  .meta({ id: "PipelineLimits" });

export const PipelineGraph = z
  .object({
    apiVersion: z.literal(PIPELINE_API_VERSION),
    kind: z.literal(PIPELINE_KIND),
    metadata: z
      .object({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
        description: z.string().max(1000).optional(),
        labels: z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,62}$/), z.string().max(128)).optional(),
      })
      .strict(),
    inputs: z.record(PortName, PipelineInput).default({}),
    trigger: PipelineTrigger.optional(),
    steps: z.array(PipelineStep).min(1).max(PIPELINE_LIMITS.max_steps),
    outputs: z.record(PortName, PipelineRef).default({}),
    policy: PipelinePolicy.optional(),
    limits: PipelineLimits.optional(),
  })
  .strict()
  .superRefine((g, ctx) => {
    // Cheap structural checks; the Go compiler is authoritative (cycles, types, resolution).
    const ids = new Set<string>();
    g.steps.forEach((s, i) => {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `step ${s.id} is defined twice` });
      ids.add(s.id);
    });
    g.steps.forEach((s, i) =>
      s.needs.forEach((n, j) => {
        if (!ids.has(n)) ctx.addIssue({ code: "custom", path: ["steps", i, "needs", j], message: `unknown step ${n}` });
      }),
    );
  })
  .meta({ id: "PipelineGraph" });
export type PipelineGraph = z.infer<typeof PipelineGraph>;
export type PipelineGraphInput = z.input<typeof PipelineGraph>;

/** Splits a reference into its parts, or null if it isn't one. */
export function parseRef(ref: string): { kind: "input"; name: string } | { kind: "step"; step: string; port: string } | null {
  const m = /^\$\{(?:inputs\.([a-z][a-z0-9_]*)|steps\.([a-z][a-z0-9_-]*)\.outputs\.([a-z][a-z0-9_]*))\}$/.exec(ref);
  if (!m) return null;
  return m[1] ? { kind: "input", name: m[1] } : { kind: "step", step: m[2]!, port: m[3]! };
}
