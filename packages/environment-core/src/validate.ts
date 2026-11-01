import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { applyPatch as apply6902, type Operation } from "rfc6902";
import SLOTS from "../reference-slots.json" with { type: "json" };

/**
 * Environment checks shared by clients (todo11 D2). The API runs the same rules in Python
 * (apps/api kernel/environment_policy.py) and is the authority; this gives the Studio, the Vite
 * seed server and the agent the same answer early. `fixtures/` holds cases both sides must agree
 * on (path and code of every error); `reference-slots.json` is the one table of where an
 * environment names a contribution and which paths an agent may patch.
 *
 * Pure: no registry, no network, no product name. The caller passes the generated
 * `schemas/environment.v1.json` and the ids of the plugins installed in the workspace.
 */

export type { Operation as JsonPatchOperation };

export type EnvErrorCode = "schema" | "reference" | "scope" | "patch";

export interface EnvError {
  /** JSON Pointer into the environment (`/viewports/0/renderer`), or `/<i>` for patch op i. */
  path: string;
  code: EnvErrorCode;
  message: string;
}

export type Principal = "person" | "agent";

export interface CheckInput {
  /** `schemas/environment.v1.json` (generated; its enums list the bundled contribution ids). */
  schema: object;
  /** Plugin ids active in the workspace: their contributions (`<pluginId>.…`) are valid references. */
  installed?: readonly string[];
  principal: Principal;
  /** The current document (saved, else the manifest's). Needed for a patch. */
  base?: Record<string, unknown> | null;
  /** RFC 6902 operations against `base`… */
  patch?: Operation[];
  /** …or a whole document (PUT). */
  environment?: unknown;
}

export interface CheckResult {
  ok: boolean;
  /** HTTP status the API answers with: 200, 403 (scope), 422 (patch, schema, reference). */
  status: 200 | 403 | 422;
  errors: EnvError[];
  environment?: Record<string, unknown>;
}

interface Slot {
  instance: string;
  schema: string;
  kind: string;
}

export const REFERENCE_SLOTS: readonly Slot[] = SLOTS.slots;
export const AGENT_PATH_PREFIXES: readonly string[] = SLOTS.agentPaths.prefixes;
const AGENT_PATH_PATTERNS = SLOTS.agentPaths.patterns.map((p) => new RegExp(p));

// ---- JSON Pointer ------------------------------------------------------------------------------

const esc = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
const unesc = (s: string) => s.replaceAll("~1", "/").replaceAll("~0", "~");
export const pointer = (parts: (string | number)[]) => parts.map((p) => "/" + esc(String(p))).join("");
const parse = (ptr: string) => (ptr === "" ? [] : ptr.slice(1).split("/").map(unesc));

function at(doc: unknown, ptr: string): unknown {
  let cur: any = doc;
  for (const part of parse(ptr)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

// ---- Patch ---------------------------------------------------------------------------------------

/** Apply a JSON Patch without mutating `base`; all ops or none. */
export function applyPatch(base: unknown, ops: unknown): { spec: Record<string, unknown>; errors?: undefined } | { spec?: undefined; errors: EnvError[] } {
  if (!Array.isArray(ops)) return { errors: [{ path: "", code: "patch", message: "A JSON Patch is an array of operations" }] };
  const draft = structuredClone(base ?? {}) as Record<string, unknown>;
  const errors: EnvError[] = [];
  // One op at a time, like the API (jsonpatch): a failing op is reported with its index.
  let doc: any = draft;
  ops.forEach((op, i) => {
    if (errors.length) return;
    const valid = op && typeof op === "object" && typeof op.op === "string" && typeof op.path === "string";
    const [r] = valid ? apply6902(doc, [op as Operation]) : [new Error("not an operation")];
    if (r) errors.push({ path: `/${i}`, code: "patch", message: `Patch op ${i} (${op?.op} ${op?.path}): ${r.message}` });
  });
  return errors.length ? { errors } : { spec: doc };
}

// ---- Agent scope (D2.3) ----------------------------------------------------------------------------

const allowedPath = (path: string) =>
  AGENT_PATH_PREFIXES.some((p) => path === p || path.startsWith(p + "/")) || AGENT_PATH_PATTERNS.some((re) => re.test(path));

const ownsId = (installed: readonly string[], id: string) => installed.some((p) => id === p || id.startsWith(p + "."));

/**
 * Operations an agent principal may not make: anything outside the allowlisted paths, and module
 * changes other than plugins installed in the workspace. `base` is the document before the patch.
 */
export function scopeErrors(ops: Operation[], installed: readonly string[] = [], base?: Record<string, unknown> | null): EnvError[] {
  const errors: EnvError[] = [];
  const current = (base?.modules ?? {}) as Record<string, unknown>;
  ops.forEach((op, i) => {
    const paths = [op.path, ...("from" in op && typeof op.from === "string" ? [op.from] : [])];
    for (const path of paths) {
      const parts = parse(path);
      if (parts[0] === "modules") {
        const id = parts[1];
        if (id === undefined) {
          errors.push({ path: `/${i}`, code: "scope", message: `Patch op ${i}: an agent can change one module at a time (/modules/<id>), not the whole map` });
        } else if (!installed.includes(id) && !(op.op === "remove" && id in current)) {
          errors.push({ path: `/${i}`, code: "scope", message: `Patch op ${i}: ${id} isn't installed in this workspace; ask the user to install it first` });
        }
        continue;
      }
      if (!allowedPath(path))
        errors.push({ path: `/${i}`, code: "scope", message: `Patch op ${i} (${op.op} ${path}): an agent can change ${AGENT_PATH_PREFIXES.join(", ")}, viewport config and installed modules only` });
    }
  });
  return errors;
}

// ---- Shape (schema minus reference enums) -------------------------------------------------------------

const shapeCache = new WeakMap<object, ValidateFunction>();

/** The schema without the enums that list contribution ids: those are checked by `referenceErrors`. */
export function shapeSchema(schema: object): object {
  const copy = structuredClone(schema) as any;
  for (const slot of REFERENCE_SLOTS) {
    const parts = parse(slot.schema);
    const key = parts.pop()!;
    const parent = at(copy, pointer(parts)) as Record<string, unknown> | undefined;
    if (parent && key in parent) delete parent[key];
  }
  return copy;
}

function shapeValidator(schema: object): ValidateFunction {
  let v = shapeCache.get(schema);
  if (!v) {
    const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
    v = ajv.compile(shapeSchema(schema));
    shapeCache.set(schema, v);
  }
  return v;
}

/** Normalized so both languages report the same paths: one error per extra or missing property. */
function normalize(errs: ErrorObject[]): EnvError[] {
  const anyOf = errs.filter((e) => e.keyword === "anyOf").map((e) => e.instancePath);
  const out: EnvError[] = [];
  for (const e of errs) {
    if (e.keyword !== "anyOf" && anyOf.some((p) => e.instancePath === p || e.instancePath.startsWith(p + "/"))) continue;
    let path = e.instancePath;
    if (e.keyword === "additionalProperties") path += "/" + esc(String((e.params as { additionalProperty: string }).additionalProperty));
    else if (e.keyword === "required") path += "/" + esc(String((e.params as { missingProperty: string }).missingProperty));
    out.push({ path, code: "schema", message: `${path || "/"}: ${e.message ?? e.keyword}` });
  }
  return dedupe(out);
}

function dedupe(errors: EnvError[]): EnvError[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const k = `${e.code} ${e.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function shapeErrors(spec: unknown, schema: object): EnvError[] {
  const v = shapeValidator(schema);
  return v(spec) ? [] : normalize(v.errors ?? []);
}

// ---- References -----------------------------------------------------------------------------------

/** Every (pointer, id) the environment names in `slot`. */
function* slotValues(spec: unknown, slot: Slot): Generator<[string, unknown]> {
  const parts = parse(slot.instance);
  function* walk(node: unknown, i: number, path: (string | number)[]): Generator<[string, unknown]> {
    if (i === parts.length) {
      yield [pointer(path), node];
      return;
    }
    const part = parts[i];
    if (node == null || typeof node !== "object") return;
    if (part === "*") {
      for (const [k, v] of Array.isArray(node) ? node.map((v, j) => [j, v] as const) : Object.entries(node)) yield* walk(v, i + 1, [...path, k]);
    } else if (part === "{key}") {
      if (!Array.isArray(node)) for (const k of Object.keys(node)) yield [pointer([...path, k]), k];
    } else if (part in (node as object)) {
      yield* walk((node as Record<string, unknown>)[part], i + 1, [...path, part]);
    }
  }
  yield* walk(spec, 0, []);
}

export function referenceErrors(spec: unknown, schema: object, installed: readonly string[] = []): EnvError[] {
  const errors: EnvError[] = [];
  for (const slot of REFERENCE_SLOTS) {
    const known = new Set((at(schema, slot.schema) as string[] | undefined) ?? []);
    for (const [path, id] of slotValues(spec, slot)) {
      if (typeof id !== "string" || known.has(id) || ownsId(installed, id)) continue;
      errors.push({ path, code: "reference", message: `${path}: no ${slot.kind} contribution "${id}" in the catalogue or the workspace's installed plugins` });
    }
  }
  return dedupe(errors);
}

// ---- The whole check ----------------------------------------------------------------------------

/** What the API decides for a write: scope (agents), patch, shape, references. */
export function checkWrite(input: CheckInput): CheckResult {
  const installed = input.installed ?? [];
  let environment: unknown;
  if (input.patch !== undefined) {
    if (input.principal === "agent" && Array.isArray(input.patch)) {
      const scope = scopeErrors(input.patch, installed, input.base);
      if (scope.length) return { ok: false, status: 403, errors: scope };
    }
    const r = applyPatch(input.base ?? {}, input.patch);
    if (r.errors) return { ok: false, status: 422, errors: r.errors };
    environment = r.spec;
  } else {
    if (input.principal === "agent") return { ok: false, status: 403, errors: [{ path: "", code: "scope", message: "an agent changes an environment with a patch, never by replacing it" }] };
    environment = input.environment;
  }
  if (environment === null || typeof environment !== "object" || Array.isArray(environment))
    return { ok: false, status: 422, errors: [{ path: "", code: "schema", message: "environment must be an object" }] };
  const errors = [...shapeErrors(environment, input.schema), ...referenceErrors(environment, input.schema, installed)];
  return errors.length ? { ok: false, status: 422, errors } : { ok: true, status: 200, errors: [], environment: environment as Record<string, unknown> };
}
