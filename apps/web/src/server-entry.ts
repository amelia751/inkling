/**
 * What the dev server (apps/web/dev/seed-server.ts) and scripts/emit-schemas.mjs load
 * through Vite's SSR module loader: the bundled registry plus pure platform functions, so
 * server-side validation uses exactly the client's modules and resolver.
 */
import "./bundle";
import { catalogPrompt, describeCatalog, environmentJsonSchema } from "./platform/catalog";
import type { EnvironmentSpec } from "./platform/environment";
import { patchSpec, type JsonPatchOperation } from "./platform/patch";
import { registry } from "./platform/registry";
import { resolveEnvironment, type EnvError } from "./platform/resolve";

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

/** The environment a manifest project boots with (v1 entries are migrated). */
export { normalizeProject } from "./lib/api";
