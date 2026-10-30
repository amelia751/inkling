import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Runtime names from the naming config (packages/plugin-contracts/src/naming.ts, emitted to
 * schemas/naming.json), so the product name never appears in this service's code (todo2 D3).
 * `AGENT_NAMING_FILE` overrides the path (a deployed image that doesn't ship the repo).
 */
export interface Naming {
  displayName: string;
  namespace: string;
  schemaPrefix: string;
  resourcePrefix: string;
  envPrefix: string;
  legacyNamespaces: string[];
}

export const NAMING_FILE = process.env.AGENT_NAMING_FILE ?? resolve(import.meta.dirname, "../../../schemas/naming.json");

export const NAMING: Naming = JSON.parse(readFileSync(NAMING_FILE, "utf8")) as Naming;

/** A full id in the current namespace: ns("segmentation") → "<namespace>.segmentation". */
export const ns = (local: string) => `${NAMING.namespace}.${local}`;

/** Map an id under a legacy namespace to the current one. */
export function canonicalId(id: string): string {
  for (const old of NAMING.legacyNamespaces) if (id.startsWith(`${old}.`)) return `${NAMING.namespace}.${id.slice(old.length + 1)}`;
  return id;
}
