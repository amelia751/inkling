import * as z from "zod";
import { NAMING } from "./naming";
import { PluginId, Semver } from "./plugin-manifest";

/**
 * Converter contract (todo10 Phase 6, ladder rung 2): a small module that turns one file we
 * don't support into a **canonical shape** the Studio already displays, so a new format needs a
 * converter and an environment, not a viewer. No UI, no network, one input file in, one output
 * folder out. It runs in the worker (Python in its own process, or a WebAssembly module under
 * wasmtime) on read-only input; jco runs the same WebAssembly in the browser or Node.
 *
 *   `converter.yaml`          ConverterManifest (in the converter package root)
 *   `<out>/output.json`       ConverterOutput (written by the converter, validated by the worker)
 *   back to the agent         ConversionSummary (fixed schema: numbers, enums, paths; no free text)
 *
 * Canonical shapes (todo10 §1.2):
 *   - `zarr`:   n-dimensional arrays (images, volumes, pyramids) as a Zarr v3 store
 *   - `arrow`:  tables as an Arrow IPC file
 *   - `assets`: files an existing data kind already reads (`.nii.gz`, `.png`, `.json` signals…),
 *               with the data kind to use in the environment
 */

export const CONVERTER_SCHEMA_VERSION = `${NAMING.schemaPrefix}.converters/v1`;

export const CANONICAL_SHAPES = ["zarr", "arrow", "assets"] as const;
export const CanonicalShape = z.enum(CANONICAL_SHAPES);
export type CanonicalShape = z.infer<typeof CanonicalShape>;

/** Why a conversion failed. The only failure detail that leaves the worker: raw messages stay inside. */
export const CONVERSION_ERRORS = [
  "unsupported-input",
  "invalid-output",
  "output-too-large",
  "timeout",
  "memory",
  "crash",
  "denied",
  "converter-invalid",
] as const;
export const ConversionError = z.enum(CONVERSION_ERRORS);
export type ConversionError = z.infer<typeof ConversionError>;

const REL_PATH = /^(?!\/)(?!.*\.\.)[\w./-]+$/;
const RelPath = z.string().regex(REL_PATH, "a path relative to the package or output root, without ..");
const Ext = z.string().regex(/^\.[a-z0-9]+(?:\.[a-z0-9]+)?$/, "a lower-case extension with its dot, e.g. .mha or .nii.gz");

export const MagicBytes = z
  .object({
    offset: z.number().int().min(0).max(65536),
    hex: z.string().regex(/^(?:[0-9a-f]{2}){1,32}$/, "lower-case hex, 1–32 bytes"),
  })
  .strict();

export const ConverterAccepts = z
  .object({
    /** Extensions this converter reads (`.mha`, `.mhd`). At least one of ext / mediaTypes. */
    ext: z.array(Ext).default([]),
    mediaTypes: z.array(z.string()).default([]),
    /** Any of these must match when given (checked by the worker before running). */
    magic: z.array(MagicBytes).default([]),
    /** Header text (`ObjectType = Image`), matched in the first 4 KB; all must be present. */
    headerContains: z.array(z.string().min(1).max(64)).default([]),
  })
  .strict()
  .refine((a) => a.ext.length > 0 || a.mediaTypes.length > 0, "accepts needs ext or mediaTypes");

export const ConverterRuntime = z.discriminatedUnion("kind", [
  /** `module.path:function(input: Path, out: Path, options: dict) -> dict` (the ConverterOutput), in its own process. */
  z
    .object({
      kind: z.literal("python"),
      entrypoint: z.string().regex(/^[a-z_][\w.]*:[a-z_]\w*$/, "module.path:function"),
    })
    .strict(),
  /**
   * A WASI command module (`wasi-p1`) or component (`wasi-p2`), run by wasmtime in the worker
   * and by jco in the browser / Node: `argv = [name, "/in/<file>", "/out"]`, `/in` preopened
   * read-only and `/out` writable, no sockets, no environment. It writes `/out/output.json`.
   */
  z
    .object({
      kind: z.literal("wasm"),
      module: RelPath.describe("The .wasm file in the package"),
      abi: z.enum(["wasi-p1", "wasi-p2"]).default("wasi-p1"),
      /** Extra arguments after the input and output paths (fixed; no user text). */
      args: z.array(z.string().regex(/^[\w.=:-]{1,64}$/)).max(16).default([]),
      /** Fuel (instructions, in millions) before the run is stopped; the timeout still applies. */
      fuelMillions: z.number().int().positive().max(1_000_000).optional(),
    })
    .strict(),
]);
export type ConverterRuntime = z.infer<typeof ConverterRuntime>;

export const ConverterLimits = z
  .object({
    timeoutS: z.number().int().positive().max(900).default(120),
    memoryMb: z.number().int().positive().max(8192).default(1024),
    maxOutputMb: z.number().int().positive().max(4096).default(512),
  })
  .strict();

/** `converter.yaml`. Strict: an unknown (possibly privileged) field is an error, like plugin.yaml. */
export const ConverterManifest = z
  .object({
    schemaVersion: z.literal(CONVERTER_SCHEMA_VERSION).optional(),
    id: PluginId,
    version: Semver,
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(400),
    accepts: ConverterAccepts,
    produces: CanonicalShape,
    /** For `assets`: the media type it writes and the data kind (full id) that displays it. */
    output: z
      .object({
        mediaType: z.string().optional(),
        ext: Ext.optional(),
        dataKind: z.string().optional().describe("Full data kind id, e.g. <namespace>.volume.dataKinds.nifti"),
        preset: z.string().regex(/^preset:[\w-]+$/).optional().describe("Preset that shows it, e.g. preset:volume-3d"),
      })
      .strict()
      .default({}),
    runtime: ConverterRuntime,
    limits: ConverterLimits.default({ timeoutS: 120, memoryMb: 1024, maxOutputMb: 512 }),
    /** Synthetic fixtures the converter was tested on (paths in the package), for review. */
    fixtures: z.array(RelPath).default([]),
  })
  .strict()
  .meta({ id: "ConverterManifest" });
export type ConverterManifest = z.infer<typeof ConverterManifest>;

const DTYPES = ["bool", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float16", "float32", "float64"] as const;
export const Dtype = z.enum(DTYPES);

export const ZarrArrayOut = z
  .object({
    path: RelPath.describe("Array path inside the store"),
    shape: z.array(z.int().min(1)).min(1).max(8),
    dtype: Dtype,
    chunks: z.array(z.int().min(1)).min(1).max(8),
    dimensionNames: z.array(z.string().regex(/^[a-z]{1,16}$/)).optional(),
    /** Physical spacing per dimension (mm, s…), when known. */
    spacing: z.array(z.number().positive()).optional(),
  })
  .strict();

export const AssetOut = z
  .object({
    path: RelPath,
    mediaType: z.string(),
    role: z.enum(["cine", "reference", "thumbnail"]).optional(),
    width: z.int().min(1).optional(),
    height: z.int().min(1).optional(),
    frames: z.int().min(1).optional(),
  })
  .strict();

/** `<out>/output.json`: what the converter says it wrote. The worker checks every file exists, inside `<out>`. */
export const ConverterOutput = z
  .discriminatedUnion("shape", [
    z.object({ shape: z.literal("zarr"), store: RelPath, arrays: z.array(ZarrArrayOut).min(1) }).strict(),
    z.object({ shape: z.literal("arrow"), file: RelPath, rows: z.int().min(0), columns: z.array(z.object({ name: z.string().max(128), type: z.string().max(64) }).strict()).min(1) }).strict(),
    z.object({ shape: z.literal("assets"), assets: z.array(AssetOut).min(1), dataKind: z.string().optional() }).strict(),
  ])
  .meta({ id: "ConverterOutput" });
export type ConverterOutput = z.infer<typeof ConverterOutput>;

/** One output file as the worker measured it (not as the converter claimed). */
export const ConvertedFile = z
  .object({
    path: RelPath,
    mediaType: z.string(),
    bytes: z.int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Arrays and images: dimensions and dtype read back from the file. */
    dims: z.array(z.int().min(1)).optional(),
    dtype: Dtype.optional(),
    /** Numeric value range (arrays), as numbers only. */
    range: z.tuple([z.number(), z.number()]).optional(),
  })
  .strict();

/**
 * What a conversion returns to the agent and the job summary (fixed schema, §6.1 step 4): no
 * exception text, no header values, no file names from the input. `line` is a line number in
 * the converter's own source when it failed there.
 */
export const ConversionSummary = z
  .object({
    ok: z.boolean(),
    converter: z.object({ id: PluginId, version: Semver, runtime: z.enum(["python", "wasm"]) }).strict(),
    shape: CanonicalShape.optional(),
    error: ConversionError.optional(),
    line: z.int().min(1).optional(),
    files: z.array(ConvertedFile).default([]),
    dataKind: z.string().optional(),
    durationMs: z.int().min(0),
  })
  .strict()
  .meta({ id: "ConversionSummary" });
export type ConversionSummary = z.infer<typeof ConversionSummary>;

/** Does this converter claim the file (extension or media type, then magic bytes if declared)? */
export function converterAccepts(m: Pick<ConverterManifest, "accepts">, file: { name: string; mediaType?: string; head?: Uint8Array }): boolean {
  const name = file.name.toLowerCase();
  const byName = m.accepts.ext.some((e) => name.endsWith(e)) || (!!file.mediaType && m.accepts.mediaTypes.includes(file.mediaType));
  if (!byName) return false;
  if (!m.accepts.magic.length || !file.head) return true;
  const head = file.head;
  return m.accepts.magic.some(({ offset, hex }) => {
    const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
    return bytes.every((b, i) => head[offset + i] === b);
  });
}
