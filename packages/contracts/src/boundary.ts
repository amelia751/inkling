import * as z from "zod";

/**
 * The data boundary's fixed-schema reports (todo10 §6, Phase 7). What the agent, the build
 * sandbox and the model may see of a real sample: fingerprints (structure, values dropped),
 * synthetic fixture lists, verify reports, typed probe answers and job summaries. Every object
 * is strict and every string is constrained, so free text (where names and identifiers leak)
 * can't be smuggled through an unexpected field. The kernel validates worker output against
 * these schemas (emitted to `schemas/boundary/*.json`) before storing or returning anything.
 */

export const BOUNDARY_SCHEMA = {
  fingerprint: "boundary.fingerprint/v1",
  fixtures: "boundary.fixtures/v1",
  verify: "boundary.verify-report/v1",
  probe: "boundary.probe/v1",
  build: "boundary.build/v1",
  jobSummary: "boundary.job-summary/v1",
  annotations: "boundary.annotations/v1",
} as const;

/** A structural name (header field, column, dataset path): identifier-shaped, short. */
export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.:/-]{0,63}$/;
/** What a name or text that failed the free-text check becomes: its length only. */
export const PLACEHOLDER = /^<redacted:\d{1,5}>$/;
export const placeholder = (text: string) => `<redacted:${Math.min(text.length, 99999)}>`;

export const SafeName = z.union([z.string().regex(FIELD_NAME), z.string().regex(PLACEHOLDER)]);
export const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** Opaque ids the kernel minted (asset, job, fixture set). */
export const OpaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** A path inside the agent's own plugin source (never a path of customer data). */
// Segments can't start with a dot, so neither `..` nor an absolute path matches.
export const SourcePath = z.string().max(200).regex(/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/);
const Hex = (max: number) => z.string().regex(new RegExp(`^(?:[0-9a-f]{2}){1,${max}}$`));
const Uint = z.number().int().nonnegative();
const Shape = z.array(Uint).max(8);
const Finite = z.number().finite();

export const DTYPES = [
  "bool", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64",
  "float16", "float32", "float64", "complex64", "complex128", "string", "bytes", "datetime", "object", "unknown",
] as const;
export const Dtype = z.enum(DTYPES);
export const Endianness = z.enum(["little", "big", "none", "unknown"]);

export const FORMAT_KINDS = ["dicom", "nifti", "hdf5", "npy", "npz", "csv", "tsv", "parquet", "json", "png", "jpeg", "tiff", "zip", "gzip", "text", "binary"] as const;
export const SCRUB_PROFILES = ["dicom-ps3.15-annex-e-basic", "generic-structure-v1"] as const;

// ---- Table profile (todo23 D5a) -------------------------------------------------------------

/** A categorical value is shown only when it appears at least this many times (k-anonymity). */
export const PROFILE_K = 10;
/** What a rarer category, or any value that fails the free-text check, becomes: its count. */
export const CATEGORY_PLACEHOLDER = /^<category:\d{1,9}>$/;
export const LOGICAL_TYPES = ["integer", "number", "boolean", "date", "datetime", "categorical", "text", "identifier", "empty"] as const;
export const CARDINALITY_BUCKETS = ["1", "2-10", "11-100", "101-1000", "1001-10000", ">10000"] as const;
export const DATE_FREQUENCIES = ["sub-daily", "daily", "business-daily", "weekly", "monthly", "quarterly", "yearly", "irregular"] as const;

/** One column's shape: never a raw value, except categories seen at least k = 10 times. */
export const TableProfileColumn = z
  .object({
    name: SafeName,
    logicalType: z.enum(LOGICAL_TYPES),
    /** Screened as an identifier by its name or its values: nothing below is reported for it. */
    identifier: z.boolean(),
    /** Fraction of empty cells, rounded to 0.01. */
    nullRate: z.number().min(0).max(1),
    cardinality: z.enum(CARDINALITY_BUCKETS),
    /** Numeric columns: coarse quantile edges (p5, p25, p50, p75, p95), rounded to 2 significant digits. */
    quantiles: z.array(Finite).max(5).optional(),
    /** Date columns: the range rounded to the month, and the typical spacing. */
    dates: z
      .object({ from: z.string().regex(/^\d{4}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}$/), frequency: z.enum(DATE_FREQUENCIES) })
      .strict()
      .optional(),
    /** Categorical columns: value → share, only values seen ≥ k times; rarer ones as `<category:N>`. */
    categories: z
      .array(z.object({ value: z.union([SafeName, z.string().regex(CATEGORY_PLACEHOLDER)]), share: z.number().min(0).max(1) }).strict())
      .max(64)
      .optional(),
  })
  .strict();

export const TableProfile = z
  .object({
    /** Row count, rounded to 2 significant digits (and noised when `noise` is set). */
    rows: Uint,
    k: z.literal(PROFILE_K),
    noise: z.boolean(),
    columns: z.array(TableProfileColumn).max(512),
  })
  .strict()
  .meta({ id: "BoundaryTableProfile" });
export type TableProfile = z.infer<typeof TableProfile>;

// ---- Fingerprint ----------------------------------------------------------------------------

export const FingerprintField = z
  .object({
    name: SafeName,
    dtype: Dtype,
    shape: Shape.optional(),
    offset: Uint.optional(),
    /** DICOM: the tag `(gggg,eeee)` and its value representation. */
    tag: z.string().regex(/^\([0-9A-F]{4},[0-9A-F]{4}\)$/).optional(),
    vr: z.string().regex(/^[A-Z]{2}$/).optional(),
    /** Number of values (DICOM VM, list length); the values themselves are dropped. */
    count: Uint.optional(),
  })
  .strict();

export const FingerprintArray = z
  .object({ name: SafeName, dtype: Dtype, shape: Shape, endianness: Endianness, offset: Uint.optional(), order: z.enum(["C", "F"]).optional() })
  .strict();

export const FingerprintSection = z
  .object({ name: SafeName, offset: Uint, length: Uint, kind: z.enum(["header", "data", "metadata", "padding", "unknown"]) })
  .strict();

export const Fingerprint = z
  .object({
    schema: z.literal(BOUNDARY_SCHEMA.fingerprint),
    sampleId: OpaqueId,
    sampleDigest: Sha256,
    bytes: Uint,
    format: z.object({ kind: z.enum(FORMAT_KINDS), magic: Hex(16).nullable(), magicOffset: Uint }).strict(),
    endianness: Endianness,
    sections: z.array(FingerprintSection).max(64),
    fields: z.array(FingerprintField).max(512),
    arrays: z.array(FingerprintArray).max(64),
    table: z
      .object({ columns: z.array(z.object({ name: SafeName, dtype: Dtype }).strict()).max(512), rows: Uint, delimiter: z.enum([",", "\t", ";", "|"]).nullable(), header: z.boolean(), profile: TableProfile.optional() })
      .strict()
      .nullable(),
    dicom: z
      .object({
        transferSyntax: z.string().regex(/^1\.2\.840\.10008\.[0-9.]{1,40}$/).nullable(),
        modality: z.string().regex(/^[A-Z]{2,4}$/).nullable(),
        rows: Uint.nullable(),
        columns: Uint.nullable(),
        frames: Uint.nullable(),
        bitsAllocated: Uint.nullable(),
        bitsStored: Uint.nullable(),
        samplesPerPixel: Uint.nullable(),
        pixelRepresentation: Uint.nullable(),
        photometric: z.string().regex(/^[A-Z0-9_]{2,16}$/).nullable(),
        removedTags: Uint,
      })
      .strict()
      .nullable(),
    scrub: z.object({ profile: z.enum(SCRUB_PROFILES), valuesDropped: Uint, namesRedacted: Uint, textCheck: z.string().regex(/^[a-z0-9-]{1,32}$/) }).strict(),
  })
  .strict()
  .meta({ id: "BoundaryFingerprint" });
export type Fingerprint = z.infer<typeof Fingerprint>;

// ---- Synthetic fixtures ---------------------------------------------------------------------

export const Fixture = z
  .object({
    name: z.string().regex(/^fixture-\d{2}[a-z0-9-]{0,24}\.[a-z0-9.]{1,12}$/),
    bytes: Uint,
    sha256: Sha256,
    mediaType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]{1,64}$/),
    variant: z.enum(["noise", "phantom", "zeros", "edge-min", "edge-max", "planted"]),
  })
  .strict();

export const FixtureSet = z
  .object({
    schema: z.literal(BOUNDARY_SCHEMA.fixtures),
    fixtureSetId: OpaqueId,
    sampleId: OpaqueId,
    fingerprintDigest: Sha256,
    generator: z.string().regex(/^[a-z0-9-]{1,32}$/),
    seed: Uint,
    fixtures: z.array(Fixture).min(1).max(16),
    /**
     * Tables: the planted truth (anomalies, regimes, events) our worker chose, stored where only
     * the verifier reads it (todo23 D4). The builder gets its id and digest, never its contents.
     */
    truth: z.object({ truthId: OpaqueId, sha256: Sha256, plants: Uint }).strict().optional(),
  })
  .strict()
  .meta({ id: "BoundaryFixtureSet" });
export type FixtureSet = z.infer<typeof FixtureSet>;

// ---- Verify report --------------------------------------------------------------------------

/** Exception classes reported by name; anything else is `Other`. The message is never kept. */
export const ERROR_CLASSES = [
  "ImportError", "ModuleNotFoundError", "SyntaxError", "IndentationError", "NameError", "AttributeError",
  "TypeError", "ValueError", "KeyError", "IndexError", "LookupError", "AssertionError", "ZeroDivisionError",
  "OverflowError", "ArithmeticError", "MemoryError", "RecursionError", "NotImplementedError", "RuntimeError",
  "OSError", "FileNotFoundError", "PermissionError", "EOFError", "UnicodeError", "UnicodeDecodeError",
  "StructError", "BufferError", "StopIteration", "TimeoutError",
  // Raised by the harness, not the plugin:
  "NetworkBlocked", "ProcessBlocked", "WriteBlocked", "EntrypointMissing", "OutputInvalid", "NoOutput", "Timeout", "MemoryLimit", "Crash",
  "Other",
] as const;
export const ErrorClass = z.enum(ERROR_CLASSES);

export const VerifyOutput = z
  .object({
    name: SafeName,
    kind: z.enum(["array", "table", "scalar", "bytes", "mapping", "list", "none", "unknown"]),
    dtype: Dtype,
    shape: Shape,
    min: Finite.nullable(),
    max: Finite.nullable(),
    mean: Finite.nullable(),
    nanCount: Uint,
  })
  .strict();

export const VerifyReport = z
  .object({
    schema: z.literal(BOUNDARY_SCHEMA.verify),
    pass: z.boolean(),
    sampleId: OpaqueId,
    sampleDigest: Sha256,
    sourceDigest: Sha256,
    stage: z.enum(["load", "convert", "check", "done"]),
    errorClass: ErrorClass.nullable(),
    /** Where in the agent's own source the error was raised (file of the plugin source, line). */
    errorFile: SourcePath.nullable(),
    errorLine: Uint.nullable(),
    outputs: z.array(VerifyOutput).max(32),
    durationMs: Uint,
    timedOut: z.boolean(),
    toolchain: z.object({ python: z.string().regex(/^\d+\.\d+\.\d+$/), runner: z.string().regex(/^[a-z0-9-]{1,32}$/) }).strict(),
  })
  .strict()
  .meta({ id: "BoundaryVerifyReport" });
export type VerifyReport = z.infer<typeof VerifyReport>;

// ---- Probes ---------------------------------------------------------------------------------

const Offset = Uint.max(2 ** 40);
export const Probe = z.discriminatedUnion("op", [
  z.object({ op: z.literal("magic"), offset: Offset, hex: Hex(16) }).strict(),
  z.object({ op: z.literal("read_int"), offset: Offset, width: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]), signed: z.boolean(), endian: z.enum(["little", "big"]) }).strict(),
  z.object({ op: z.literal("read_float"), offset: Offset, width: z.union([z.literal(4), z.literal(8)]), endian: z.enum(["little", "big"]) }).strict(),
  z.object({ op: z.literal("find"), hex: Hex(8), start: Offset.optional(), limit: z.number().int().min(1).max(16).optional() }).strict(),
  z.object({ op: z.literal("read_text"), offset: Offset, length: z.number().int().min(1).max(32) }).strict(),
  z.object({ op: z.literal("field_names") }).strict(),
  z.object({ op: z.literal("section_sizes") }).strict(),
  z.object({ op: z.literal("size") }).strict(),
]);
export type Probe = z.infer<typeof Probe>;

export const ProbeAnswer = z
  .object({
    op: z.enum(["magic", "read_int", "read_float", "find", "read_text", "field_names", "section_sizes", "size"]),
    ok: z.boolean(),
    error: z.enum(["out_of_range", "unsupported", "budget_exhausted"]).nullable(),
    /** One of these, by op: magic → bool; read_int → int (as a decimal string past 2^53); read_float → number; read_text → checked text or placeholder; size → int. */
    value: z.union([z.boolean(), Finite, z.string().regex(/^-?\d{1,20}$/), z.string().regex(/^[A-Za-z0-9 _.:/-]{0,32}$/), z.string().regex(PLACEHOLDER)]).nullable(),
    offsets: z.array(Uint).max(16).nullable(),
    names: z.array(SafeName).max(512).nullable(),
    sections: z.array(FingerprintSection).max(64).nullable(),
  })
  .strict();
export type ProbeAnswer = z.infer<typeof ProbeAnswer>;

export const ProbeResult = z
  .object({
    schema: z.literal(BOUNDARY_SCHEMA.probe),
    sampleId: OpaqueId,
    sampleDigest: Sha256,
    answers: z.array(ProbeAnswer).max(32),
    budget: z.object({ used: Uint, limit: Uint, remaining: Uint }).strict(),
  })
  .strict()
  .meta({ id: "BoundaryProbeResult" });
export type ProbeResult = z.infer<typeof ProbeResult>;

// ---- Build (our rebuild of the agent's source) ----------------------------------------------

export const BuildResult = z
  .object({
    schema: z.literal(BOUNDARY_SCHEMA.build),
    pass: z.boolean(),
    pluginId: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/).nullable(),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).nullable(),
    /** The digest of the bundle we built and signed: the one that gets installed. */
    artifactDigest: Sha256.nullable(),
    sourceDigest: Sha256,
    /** What the build sandbox said it built; compared, never used. */
    sandboxDigest: Sha256.nullable(),
    matchesSandbox: z.boolean().nullable(),
    signature: z.object({ signer: z.string().max(32), alg: z.string().max(32), keyId: z.string().max(300), digest: Sha256, sig: z.string().max(400) }).strict().nullable(),
    dropped: z.array(z.object({ path: SourcePath, reason: z.enum(["binary", "build-output", "not-source", "too-large"]) }).strict()).max(100),
    /** Problems with the agent's own source (manifest, declarative UI); never text from customer data. */
    errors: z.array(z.string().max(500)).max(50),
    registered: z.boolean(),
    duplicate: z.boolean(),
    toolchain: z.object({ python: z.string().regex(/^\d+\.\d+\.\d+$/), builder: z.string().regex(/^[a-z0-9-]{1,32}$/) }).strict(),
  })
  .strict()
  .meta({ id: "BoundaryBuildResult" });
export type BuildResult = z.infer<typeof BuildResult>;

// ---- Job summaries --------------------------------------------------------------------------

/** Below this, counts come back as "<20" (as All of Us does), so a rare cohort can't be singled out. */
export const SMALL_COUNT = 20;
export const Count = z.union([Uint, z.literal(`<${SMALL_COUNT}`)]);
export const suppress = (n: number, min = SMALL_COUNT): number | `<${typeof SMALL_COUNT}` => (n === 0 || n >= min ? n : `<${SMALL_COUNT}`);

export const JOB_KINDS = ["fingerprint", "synthesize_fixtures", "verify_plugin", "probe", "build_plugin", "capability"] as const;
export const JobSummary = z
  .object({
    schema: z.literal(BOUNDARY_SCHEMA.jobSummary),
    jobId: OpaqueId,
    kind: z.enum(JOB_KINDS),
    state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    progress: z.number().min(0).max(1),
    counts: z.object({ total: Count, succeeded: Count, failed: Count }).strict(),
    errorClasses: z.array(z.object({ errorClass: ErrorClass, count: Count }).strict()).max(40),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .meta({ id: "BoundaryJobSummary" });
export type JobSummary = z.infer<typeof JobSummary>;

// ---- Filtered annotations -------------------------------------------------------------------

/** Geometry with its numbers and structure only: strings are dropped except `type`-like keys. */
type GeometryValue = number | boolean | null | GeometryValue[] | { [k: string]: GeometryValue };
const GeometryValue: z.ZodType<GeometryValue> = z.lazy(() => z.union([Finite, z.boolean(), z.null(), z.array(GeometryValue).max(100_000), z.record(z.string().regex(FIELD_NAME), GeometryValue)]));

export const FilteredAnnotation = z
  .object({
    id: z.string().max(128).regex(/^[A-Za-z0-9_.:-]+$/),
    itemId: z.union([z.string().max(256).regex(/^[A-Za-z0-9_./@()+=-]+$/), z.string().regex(PLACEHOLDER)]),
    /** In the task's label vocabulary, or a placeholder. */
    label: z.union([SafeName, z.string().regex(/^[A-Za-z0-9 _.:/()-]{1,64}$/)]).nullable(),
    geometry: z.object({ type: z.string().regex(FIELD_NAME) }).catchall(GeometryValue).nullable(),
    provenance: z.string().regex(/^[a-z-]{1,32}$/).nullable(),
    review: z.string().regex(/^[a-z_-]{1,32}$/).nullable(),
    /** Numbers and booleans pass; strings pass only if they are vocabulary labels, else placeholders. */
    attributes: z.record(z.string().regex(FIELD_NAME), z.union([Finite, z.boolean(), z.null(), z.string().regex(/^[A-Za-z0-9 _.:/()-]{1,64}$/), z.string().regex(PLACEHOLDER)])),
  })
  .strict();

export const FilteredAnnotations = z
  .object({ schema: z.literal(BOUNDARY_SCHEMA.annotations), total: Count, annotations: z.array(FilteredAnnotation).max(1000), redacted: Uint })
  .strict()
  .meta({ id: "BoundaryFilteredAnnotations" });
export type FilteredAnnotations = z.infer<typeof FilteredAnnotations>;

/** Every boundary schema by its emitted file name (schemas/boundary/<name>). */
export const BOUNDARY_SCHEMAS = {
  "fingerprint.v1.json": Fingerprint,
  "fixtures.v1.json": FixtureSet,
  "verify-report.v1.json": VerifyReport,
  "probe.v1.json": ProbeResult,
  "probe-request.v1.json": z.object({ probes: z.array(Probe).min(1).max(32) }).strict().meta({ id: "BoundaryProbeRequest" }),
  "build.v1.json": BuildResult,
  "job-summary.v1.json": JobSummary,
  "annotations.v1.json": FilteredAnnotations,
  "table-profile.v1.json": TableProfile,
} as const;
