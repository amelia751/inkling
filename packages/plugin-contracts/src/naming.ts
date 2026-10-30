/**
 * The only file that may contain the product name (todo/todo2.md, D3). Everything else
 * reads runtime identifiers from here: contribution-id namespace, schema prefix, resource
 * and storage prefixes, env-var prefix and the display name. `scripts/emit-schemas.mjs`
 * writes the same values to `schemas/naming.json` for the Python kernel, the worker, the
 * plugin SDK, `apps/mcp` and `apps/agent`.
 *
 * Renaming = edit this file, add the old namespace to `legacyNamespaces`, then run
 * `node tools/rename-namespace.mjs --from <old> --to <new>` for stored documents.
 */
export const NAMING = {
  displayName: "Inkling",
  namespace: "inkling",
  schemaPrefix: "inkling",
  resourcePrefix: "inkling",
  envPrefix: "INKLING_",
  legacyNamespaces: [] as string[],
} as const;

export type Naming = { -readonly [K in keyof typeof NAMING]: (typeof NAMING)[K] extends readonly string[] ? string[] : string };

/** The contribution-id namespace, for template literals: `${NS}.wsi.renderers.osd`. */
export let NS: string = NAMING.namespace;
/** Resource prefix (storage keys, runtime names, file formats), for template literals. */
export let RES: string = NAMING.resourcePrefix;

/**
 * Override naming at startup (tests, white-label builds). Must run before any module
 * manifest is imported: contribution ids are computed when manifests load.
 */
export function configureNaming(over: Partial<Naming>): void {
  Object.assign(NAMING as unknown as Naming, over);
  NS = NAMING.namespace;
  RES = NAMING.resourcePrefix;
}

/** A full id in the current namespace: `ns("wsi")` → `<namespace>.wsi`. */
export const ns = (local: string) => `${NAMING.namespace}.${local}`;

/** A namespaced env var: `env("E2E")` → `<ENVPREFIX>E2E`. */
export const envVar = (name: string) => `${NAMING.envPrefix}${name}`;

/**
 * Maps an id written under a legacy namespace to the current one; other ids pass through.
 * Every registry lookup goes through this so stored documents (presets, environments,
 * annotation geometry types) keep resolving after a rename.
 */
export function canonicalId(id: string): string {
  for (const old of NAMING.legacyNamespaces) if (id.startsWith(`${old}.`)) return `${NAMING.namespace}.${id.slice(old.length + 1)}`;
  return id;
}

/** Rewrites legacy-namespace ids inside free text such as `when` clauses (`renderer == old.wsi.renderers.osd`). */
export function canonicalText(text: string): string {
  if (!NAMING.legacyNamespaces.length) return text;
  const re = new RegExp(`(^|[^\\w.-])(${NAMING.legacyNamespaces.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.(?=[\\w-])`, "g");
  return text.replace(re, `$1${NAMING.namespace}.`);
}

/** Deep copy of a stored document (environment spec, preset) with every legacy id canonicalised, keys included. */
export function canonicalDoc<T>(doc: T): T {
  if (!NAMING.legacyNamespaces.length) return doc;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return canonicalText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [canonicalId(k), walk(x)]));
    return v;
  };
  return walk(doc) as T;
}
