import { startTransition } from "react";
import { createPatch } from "rfc6902";
import type { EnvironmentSpec } from "@studio/contracts/environment";
import { patchSpec, type JsonPatchOperation } from "@/extension-host/patch";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment, type EnvError, type ResolvedEnv } from "@/extension-host/resolve";
import { useStudio } from "@/studio/stores/studio";
import { newModules } from "./boot-priority";
import { fetchEnvironment, saveEnvironment, type ChangeProvenance } from "./api";

/**
 * The one path for changing a running environment, shared by the assistant and the config
 * forms: JSON Patch against the source spec → validate → load new modules → one undoable
 * `setEnv` step → save as a project environment edit (with its author).
 */
const revisions = new Map<string, number>();

export async function persistEnvironment(projectId: string, env: ResolvedEnv, author: string, provenance?: ChangeProvenance): Promise<void> {
  if (!revisions.has(projectId)) revisions.set(projectId, (await fetchEnvironment(projectId).catch(() => ({ revision: 0 }))).revision);
  const saved = await saveEnvironment(projectId, { revision: revisions.get(projectId)!, environment: env.source, author, ...(provenance ? { provenance } : {}) });
  revisions.set(projectId, saved.revision);
}

/**
 * Make `env` the running environment: load only the modules it adds (the running ones stay as
 * they are), then swap it in as a transition. A module that fails to load rejects, so callers
 * (the assistant's patch tool, config forms) report it instead of applying a broken setup.
 */
export async function installEnvironment(env: ResolvedEnv, opts?: { record?: boolean }): Promise<void> {
  await Promise.all(newModules(env).map((id) => registry.preload(id)));
  startTransition(() => useStudio.getState().setEnv(env, opts));
}

/** Apply a patch to the running env. Returns structured errors (nothing applied) or the new env. */
export async function patchEnvironment(projectId: string, ops: JsonPatchOperation[], author: string): Promise<{ env: ResolvedEnv } | { errors: EnvError[] }> {
  const cur = useStudio.getState().env;
  if (!cur) return { errors: [{ path: "", code: "schema", message: "No environment is running" }] };
  const p = patchSpec(cur.source, ops);
  if (p.errors) return { errors: p.errors };
  const r = resolveEnvironment(p.spec, registry);
  if (r.errors) return { errors: r.errors };
  await installEnvironment(r.env);
  await persistEnvironment(projectId, r.env, author);
  return { env: r.env };
}

/** The JSON Patch that turns one spec into another (for edits made on a whole document). */
export function diffSpecs(a: EnvironmentSpec, b: EnvironmentSpec): JsonPatchOperation[] {
  return createPatch(a, b);
}
