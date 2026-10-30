import * as z from "zod";
import { NAMING } from "./naming";

/**
 * `plugin.yaml` (docs/plugins.md §5.2): the data-only description of a plugin that the
 * registry, installer, policy engine and agent read without executing plugin code. Strict
 * everywhere, so an unknown (possibly privileged) field is a validation error rather than
 * something silently ignored. All paths are relative to the immutable package root.
 */

export const PLUGIN_SCHEMA_VERSION = `${NAMING.schemaPrefix}.plugins/v1`;

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** `<namespace>.<name>` or any dotted reverse-DNS-ish id (third parties use their own prefix). */
const PLUGIN_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const CAPABILITY_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;
const REL_PATH = /^(?!\/)(?!.*\.\.)[\w./-]+$/;

export const PluginId = z.string().regex(PLUGIN_ID, "dotted lower-case id, e.g. <namespace>.segmentation");
export const Semver = z.string().regex(SEMVER, "semver x.y.z");
const RelPath = z.string().regex(REL_PATH, "a path relative to the package root, without ..");

/**
 * Permissions a plugin can request. Granted per plugin version, workspace and actor by the
 * kernel (§10.1); requesting one grants nothing.
 */
export const Permission = z.union([
  z.enum(["assets.read", "assets.write", "annotations.read", "annotations.write", "jobs.create", "events.publish"]),
  z.string().regex(/^network\.egress:[a-z0-9.-]+(?::\d+)?$/, "network.egress:<host>"),
  z.string().regex(/^secrets\.use:[A-Z][A-Z0-9_]*$/, "secrets.use:<NAME>"),
]);
export type Permission = z.infer<typeof Permission>;

export const CapabilityDecl = z
  .object({
    id: z.string().regex(CAPABILITY_ID).describe("Capability contract id, e.g. image.segment"),
    inputSchema: RelPath.optional(),
    outputSchema: RelPath.optional(),
    tool: z.string().regex(/^[a-z][a-z0-9_]*$/).optional().describe("Tool that implements it (python-worker plugins)"),
    mediaTypes: z.array(z.string()).optional(),
  })
  .strict();

export const PluginRuntime = z.discriminatedUnion("kind", [
  /** First-party UI-only plugin compiled into the web build (trusted, todo2 D2). */
  z.object({ kind: z.literal("browser-bundled") }).strict(),
  z
    .object({
      kind: z.literal("python-worker"),
      entrypoint: z.string().regex(/^[a-z_][\w.]*:[a-z_]\w*$/, "module.path:function"),
      maxExecutionSeconds: z.number().int().positive().max(3600).default(180),
      concurrency: z.number().int().positive().max(64).default(1),
      memoryMb: z.number().int().positive().max(65536).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);

/** Pricing kept in provider metadata, never in orchestration code (§12.2). */
export const ProviderPricing = z
  .object({
    unit: z.enum(["image", "frame", "request", "second"]),
    usdPerUnit: z.number().nonnegative(),
    effectiveAt: z.string().describe("ISO date the price was read"),
    sourceUrl: z.string().url(),
  })
  .strict();

export const ProviderDecl = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9.-]*)*$/),
    implements: z.array(z.string().regex(CAPABILITY_ID)).min(1),
    configSchema: RelPath.optional(),
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).optional(),
    /** Hosts this provider calls; each must also be requested as `network.egress:<host>`. */
    egress: z.array(z.string()).optional(),
    hosting: z.enum(["hosted", "self-hosted", "local", "mock"]).optional(),
    /** Feature matrix (§12.3): text prompts, points, boxes, video, max dimensions… */
    features: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
    pricing: ProviderPricing.optional(),
    /** Model and service terms, kept apart from the plugin's code licence (§5.2). */
    modelLicense: z.string().optional(),
    serviceTerms: z.string().optional(),
  })
  .strict();

export const PluginManifest = z
  .object({
    schemaVersion: z.literal(PLUGIN_SCHEMA_VERSION),
    id: PluginId,
    name: z.string().min(1),
    version: Semver,
    description: z.string().optional(),
    publisher: z.string().min(1),
    /** Licence of the plugin CODE, not of any model it calls. */
    license: z.string().min(1),
    compatibility: z.object({ studio: z.string(), pluginApi: z.string() }).strict(),
    /** Other plugins (or Studio built-ins) this one needs: id → semver range. */
    requires: z.record(PluginId, z.string()).optional(),
    capabilities: z.array(CapabilityDecl).default([]),
    runtime: PluginRuntime,
    providers: z.array(ProviderDecl).optional(),
    ui: z
      .object({
        contributions: RelPath.optional().describe("ui/contributions.json: declarative UI on trusted renderers"),
        module: RelPath.optional().describe("Trusted TS manifest (first-party only)"),
      })
      .strict()
      .optional(),
    skills: z.array(RelPath).optional(),
    permissions: z.object({ required: z.array(Permission).default([]), optional: z.array(Permission).default([]) }).strict(),
    resources: z
      .object({
        defaultBudgetUsdPerJob: z.number().nonnegative().optional(),
        maxBudgetUsdPerJob: z.number().nonnegative().optional(),
        maxImagesPerJob: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    events: z.object({ subscribes: z.array(z.string()).default([]) }).strict().optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const perms = new Set([...m.permissions.required, ...m.permissions.optional]);
    for (const [i, p] of (m.providers ?? []).entries()) {
      for (const host of p.egress ?? [])
        if (!perms.has(`network.egress:${host}`)) ctx.addIssue({ code: "custom", path: ["providers", i, "egress"], message: `egress to ${host} needs permission network.egress:${host}` });
      for (const s of p.secrets ?? [])
        if (!perms.has(`secrets.use:${s}`)) ctx.addIssue({ code: "custom", path: ["providers", i, "secrets"], message: `secret ${s} needs permission secrets.use:${s}` });
      for (const c of p.implements)
        if (!m.capabilities.some((x) => x.id === c)) ctx.addIssue({ code: "custom", path: ["providers", i, "implements"], message: `provider implements undeclared capability ${c}` });
    }
    if (m.runtime.kind === "python-worker" && m.ui?.module) ctx.addIssue({ code: "custom", path: ["ui", "module"], message: "python-worker plugins can't ship a trusted TS module; use ui.contributions" });
  })
  .meta({ id: "PluginManifest" });

export type PluginManifest = z.infer<typeof PluginManifest>;
export type PluginManifestInput = z.input<typeof PluginManifest>;
export type CapabilityDecl = z.infer<typeof CapabilityDecl>;
export type ProviderDecl = z.infer<typeof ProviderDecl>;
