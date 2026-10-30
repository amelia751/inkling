/**
 * What the dev server (apps/web/dev/seed-server.ts) and scripts/emit-schemas.mjs load
 * through Vite's SSR module loader: the bundled registry plus pure platform functions, so
 * server-side validation uses exactly the client's modules and resolver.
 */
import * as z from "zod";
import { imageSegment } from "@studio/plugin-contracts/capabilities";
import { NAMING } from "@studio/plugin-contracts/naming";
import { PluginManifest } from "@studio/plugin-contracts/plugin-manifest";
import { UiContributions } from "@studio/plugin-contracts/ui-contributions";
import { WorkspaceState } from "@studio/plugin-contracts/workspace";
import "@/extension-host/bundled";
import { catalogPrompt, describeCatalog, environmentJsonSchema } from "@/extension-host/catalog";
import type { EnvironmentSpec } from "@studio/plugin-contracts/environment";
import { patchSpec, type JsonPatchOperation } from "@/extension-host/patch";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment, type EnvError } from "@/extension-host/resolve";

export const catalog = () => describeCatalog(registry);
export const prompt = () => catalogPrompt(registry);
export const schema = () => environmentJsonSchema(registry);

type Validated = { ok: true; spec: EnvironmentSpec; resolved: EnvironmentSpec } | { ok: false; errors: EnvError[] };

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

export { NAMING, envVar } from "@studio/plugin-contracts/naming";

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
    "capabilities/image.segment.request.json": js(imageSegment.SegmentRequest, "capabilities/image.segment/request"),
    "capabilities/image.segment.result.json": js(imageSegment.SegmentResult, "capabilities/image.segment/result"),
  };
}

/** The environment a manifest project boots with (v1 entries are migrated). */
export { normalizeProject } from "@/studio/lib/api";
