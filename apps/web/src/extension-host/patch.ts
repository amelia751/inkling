import { applyPatch, type Operation } from "rfc6902";
import type { EnvironmentSpec } from "@studio/contracts/environment";
import type { EnvError } from "./resolve";

export type { Operation as JsonPatchOperation };

/**
 * Apply an RFC 6902 JSON Patch to an environment spec without mutating it. rfc6902 applies
 * ops in place and reports per-op errors, so this works on a clone and commits only when
 * every op succeeded: a failed patch never leaves a half-edited spec.
 */
export function patchSpec(spec: EnvironmentSpec, ops: Operation[]): { spec: EnvironmentSpec; errors?: undefined } | { spec?: undefined; errors: EnvError[] } {
  if (!Array.isArray(ops)) return { errors: [{ path: "", code: "schema", message: "A JSON Patch is an array of operations" }] };
  const draft = structuredClone(spec);
  const results = applyPatch(draft, ops);
  const errors: EnvError[] = results.flatMap((r, i) =>
    r ? [{ path: `/${i}`, code: "schema" as const, message: `Patch op ${i} (${ops[i]?.op} ${ops[i]?.path}): ${r.message}` }] : [],
  );
  return errors.length ? { errors } : { spec: draft };
}
