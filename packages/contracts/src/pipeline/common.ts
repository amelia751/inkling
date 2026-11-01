import * as z from "zod";

/**
 * Shared scalars for the pipeline contracts (docs/pipeline.md, todo/todo12.md §4 Milestone 1).
 * Every regex here must also compile as RE2: apps/pipeline (Go) validates against the emitted
 * JSON Schemas, so no lookarounds or backreferences.
 *
 * Wire names are snake_case, like the kernel outbox envelope and versioning's API, because the
 * same documents cross Python, Go and TypeScript.
 */

/** `sha256:<64 hex>`. */
export const PipelineDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "sha256:<64 hex>");
/** A step id inside one graph: `inspect`, `normalize-imaging`. */
export const PipelineStepId = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/, "lower-case step id");
/** An input or output port name: `source`, `valid_scans`. */
export const PortName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "lower-case port name");
/** Ids minted by other services (kernel workspace/project/job ids, run ids). Opaque, never free text. */
export const ServiceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "opaque id");
/** A versioning commit oid (SHA-1 or SHA-256 hex). */
export const CommitOid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "git oid");
/** UTC timestamp, RFC 3339. */
export const Timestamp = z.iso.datetime({ offset: false });
/** An idempotency key: `<run_id>/<step_id>/<partition_id>`, `<run_id>/<event>[/<step_id>]`. */
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/#@-]{0,254}$/, "idempotency key");
/** A dotted step implementation id (plugin id or platform operation), same shape as a plugin id. */
export const StepImplId = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/, "dotted lower-case id");
export const SemverString = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "semver x.y.z");

/** JSON values allowed in step parameters (no functions, no undefined). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null(), z.array(JsonValue).max(256), z.record(z.string().max(128), JsonValue)]),
);

/** Kernel resource classes (todo12 §4 Milestone 0, kernel item 3). */
export const RESOURCE_CLASSES = ["cpu", "memory", "gpu"] as const;
export const ResourceClass = z.enum(RESOURCE_CLASSES);
