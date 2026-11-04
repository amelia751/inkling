/**
 * What the dev server (apps/web/dev/seed-server.ts) and scripts/emit-schemas.mjs load
 * through Vite's SSR module loader: the bundled registry plus pure platform functions, so
 * server-side validation uses exactly the client's modules and resolver.
 */
import * as z from "zod";
import { imageSegment } from "@studio/contracts/capabilities";
import { operationsDocument } from "@studio/contracts/operations";
import { annotationRevisionJsonSchema } from "@studio/contracts/annotation-revision";
import { ConversionSummary, ConverterManifest, ConverterOutput } from "@studio/contracts/converter";
import { NAMING } from "@studio/contracts/naming";
import { MCP_APP_MIME, MCP_APPS_PROTOCOL, VIEWER_CSP, VIEWER_TEMPLATE, VIEWER_TOOLS } from "@studio/plugin-ui-sdk/viewer";
import { PluginManifest } from "@studio/contracts/plugin-manifest";
import { UiContributions } from "@studio/contracts/ui-contributions";
import { WorkspaceState } from "@studio/contracts/workspace";
import { PluginsLock } from "@studio/contracts/lockfile";
import { Recipe } from "@studio/contracts/recipe";
import { BOUNDARY_SCHEMAS } from "@studio/contracts/boundary";
import { PIPELINE_SCHEMAS, pipelineDocuments } from "@studio/contracts/pipeline";
import { DatasetStructure } from "@studio/contracts/dataset-structure";
import { DropPlan } from "@studio/contracts/drop-plan";
import { OssEvaluation } from "@studio/contracts/oss-evaluation";
import { Rules } from "@studio/contracts/rules";
import { lintRulesDocument, lintRulesMarkdown, WriteRejected } from "@studio/contracts/lint-rules";
export { lintRulesMarkdown };
import { BUILTIN_MODULES } from "@/extension-host/bundled";
import { catalogForKind, catalogPrompt, describeCatalog, environmentJsonSchema } from "@/extension-host/catalog";
import type { EnvironmentSpec } from "@studio/contracts/environment";
import { patchSpec, type JsonPatchOperation } from "@/extension-host/patch";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment, type EnvError } from "@/extension-host/resolve";
import { checkWrite, type CheckResult, type EnvError as CoreError, type JsonPatchOperation as CoreOperation } from "@studio/environment-core";

export const catalog = () => describeCatalog(registry);
/** `?kind=<detected kind>` on the catalogue read (todo13 "Find a plugin"). */
export const catalogOfKind = (kind: string) => catalogForKind(describeCatalog(registry), kind);
export { listCapabilities } from "@/extension-host/agent";

/** Dev workspace state when seed-data/<project>/workspace.json is absent: every bundled plugin active. */
export function allBundledState(workspaceId: string) {
  const builtin = new Set(BUILTIN_MODULES.map((m) => m.id));
  // Plugins with a worker runtime need the kernel; without it they'd show UI that can't run.
  const needsKernel = new Set(PLUGIN_PACKAGES.packages.filter((p) => p.manifest.runtime.kind === "python-worker").map((p) => p.manifest.id));
  return { workspaceId, plugins: registry.listAvailable().filter((m) => !builtin.has(m.id) && !needsKernel.has(m.id)).map((m) => ({ pluginId: m.id, version: m.version, state: "ACTIVATED" })) };
}
import { PLUGIN_PACKAGES } from "@/extension-host/manifests";
export { PLUGIN_PACKAGES };
export const prompt = () => catalogPrompt(registry);
export const schema = () => environmentJsonSchema(registry);

type Validated = { ok: true; spec: EnvironmentSpec; resolved: EnvironmentSpec } | { ok: false; errors: EnvError[] };

let shapeSchemaCache: { key: string; schema: object } | undefined;
/** The generated environment schema, one object per distinct registry state (environment-core caches its validator by identity). */
function coreSchema(): object {
  const live = schema();
  const key = JSON.stringify(live);
  if (shapeSchemaCache?.key !== key) shapeSchemaCache = { key, schema: live };
  return shapeSchemaCache.schema;
}

/**
 * The API's write checks (todo11 D2, `@studio/environment-core`, the same rules as
 * kernel/environment_policy.py): JSON Patch, shape and references against the generated schema,
 * with every plugin the dev registry knows counted as installed. The dev server has no tokens, so
 * the caller is a person. `status` is the HTTP status the API would answer with.
 */
export function checkEnvironmentWrite(input: { base?: Record<string, unknown> | null; patch?: CoreOperation[]; environment?: unknown }): CheckResult {
  return checkWrite({ schema: coreSchema(), installed: PLUGIN_PACKAGES.packages.map((p) => p.manifest.id), principal: "person", ...input });
}

/**
 * `POST /api/environments/validate` and dev-server writes: the API's checks first (same errors,
 * `{path, code, message}`), then the Studio's resolver on top (`extends` merge, overrides, module
 * requirements). Returns `{ok:false, errors}` like the API.
 */
export function validateWrite(input: { base?: Record<string, unknown> | null; patch?: CoreOperation[]; environment?: unknown }): (Validated & { status?: undefined }) | { ok: false; status: 403 | 422; errors: (EnvError | CoreError)[] } {
  const core = checkEnvironmentWrite(input);
  if (!core.ok) return { ok: false, status: core.status === 200 ? 422 : core.status, errors: core.errors };
  return validate(core.environment);
}

/** Validate a spec; on success also returns `resolved`, the spec with `extends` merged in. */
export function validate(spec: unknown): Validated {
  const r = resolveEnvironment(spec, registry);
  return r.errors ? { ok: false, errors: r.errors } : { ok: true, spec: spec as EnvironmentSpec, resolved: r.env.spec };
}

/** Patch the stored spec (not the merged one: `extends` stays a reference) and validate the result. */
export function patch(spec: EnvironmentSpec, ops: JsonPatchOperation[]): Validated {
  const p = patchSpec(spec, ops);
  if (p.errors) return { ok: false, errors: p.errors };
  return validate(p.spec);
}

export { NAMING, envVar } from "@studio/contracts/naming";
export { contentHash, NULL_CONTENT_HASH } from "@studio/contracts/canonical";

/**
 * JSON Schemas of the shared contracts (todo2 §2.1), the source the Python kernel generates
 * its pydantic models from (apps/api: studio_api.kernel.contracts.generate).
 */
export function contractSchemas(): Record<string, unknown> {
  const js = (s: z.ZodType, id: string) => ({ ...(z.toJSONSchema(s, { unrepresentable: "any", io: "input" }) as object), $id: `${NAMING.schemaPrefix}://schema/${id}` });
  return {
    "plugin.v1.json": js(PluginManifest, "plugin/v1"),
    "ui-contributions.v1.json": js(UiContributions, "ui-contributions/v1"),
    "workspace.v1.json": js(WorkspaceState, "workspace/v1"),
    "plugins-lock.v1.json": js(PluginsLock, "plugins-lock/v1"),
    "converter.v1.json": js(ConverterManifest, "converter/v1"),
    // todo23 W7: a recipe folder (SKILL.md frontmatter, environment, plugins.lock, verification).
    "recipe.v1.json": js(Recipe, "recipe/v1"),
    "converter-output.v1.json": js(ConverterOutput, "converter-output/v1"),
    "conversion-summary.v1.json": js(ConversionSummary, "conversion-summary/v1"),
    "capabilities/image.segment.request.json": js(imageSegment.SegmentRequest, "capabilities/image.segment/request"),
    "capabilities/image.segment.result.json": js(imageSegment.SegmentResult, "capabilities/image.segment/result"),
    // The rung-4 viewer document (packages/plugin-ui-sdk/src/viewer.ts), read by apps/mcp to serve viewers as MCP Apps resources.
    "viewer-runtime.v1.json": { $id: `${NAMING.schemaPrefix}://schema/viewer-runtime/v1`, protocolVersion: MCP_APPS_PROTOCOL, mimeType: MCP_APP_MIME, tools: VIEWER_TOOLS, csp: VIEWER_CSP, template: VIEWER_TEMPLATE },
    // Read by apps/versioning (Go); keeps its file-relative $id.
    "versioning/annotation-revision.schema.json": annotationRevisionJsonSchema(),
    // The data boundary's fixed-schema reports (todo10 Phase 7); the kernel validates worker output against them.
    ...Object.fromEntries(Object.entries(BOUNDARY_SCHEMAS).map(([name, s]) => [`boundary/${name}`, js(s, `boundary/${name.replace(/\.json$/, "")}`)])),
    // Pipeline contracts (todo12 Milestone 1), read by apps/pipeline (Go), plus its generated documents.
    ...Object.fromEntries(Object.entries(PIPELINE_SCHEMAS).map(([path, s]) => [path, js(s, path.replace(/\.json$/, ""))])),
    ...pipelineDocuments(),
    // todo13 §5: the dataset structure the kernel validates `structure.json` writes against, and the drop plan.
    "dataset-structure.v1.json": js(DatasetStructure, "dataset-structure/v1"),
    "drop-plan.v1.json": js(DropPlan, "drop-plan/v1"),
    // todo23 D6: the open-source scout's evaluation record, stored with the plugin or kit.
    "oss-evaluation.v1.json": js(OssEvaluation, "oss-evaluation/v1"),
    // todo16 D7: the operations catalogue, read by apps/mcp and the kernel's tests.
    "operations.json": { $id: `${NAMING.schemaPrefix}://schema/operations/v1`, ...operationsDocument() },
    // todo17 D3/D4/D6: project rules, the lint rule catalogue and the write-rejected problem JSON, read by the kernel.
    "rules.v1.json": js(Rules, "rules/v1"),
    "lint-rules.json": lintRulesDocument(),
    "write-rejected.v1.json": js(WriteRejected, "write-rejected/v1"),
  };
}

/** The environment a manifest project boots with (v1 entries are migrated). */
export { normalizeProject } from "@/studio/lib/api";
