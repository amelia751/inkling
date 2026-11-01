import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Catalog, type IntentTable, compactPresetIndex } from "@studio/studio-tools";
import type { Config } from "../config.ts";

/**
 * The catalogue and the preset intent table (todo11 Milestone 2), read once when the service starts
 * (not request state): the compact preset index goes into the system prompt in place of the ~30 KB
 * catalogue the browser used to send, and `search_catalog` answers the rest on demand.
 *
 * Defaults are the repo files next to this service; the image copies `schemas/` and
 * `registry/intents.json` to the same relative place (apps/agent/Dockerfile).
 */
const REPO = resolve(import.meta.dirname, "../../../..");
export const DEFAULT_CATALOG_FILE = resolve(REPO, "schemas/catalog.json");
export const DEFAULT_INTENTS_FILE = resolve(REPO, "registry/intents.json");

export interface StudioCatalog {
  catalog: Catalog;
  intents: IntentTable;
  /** The prompt text: presets and modules, one line each, sorted (byte-stable for prompt caching). */
  index: string;
}

export function loadStudioCatalog(config: Pick<Config, "studioFiles">): StudioCatalog {
  const catalog = JSON.parse(readFileSync(config.studioFiles.catalog ?? DEFAULT_CATALOG_FILE, "utf8")) as Catalog;
  const intents = JSON.parse(readFileSync(config.studioFiles.intents ?? DEFAULT_INTENTS_FILE, "utf8")) as IntentTable;
  if (!Array.isArray(catalog.contributions) || !Array.isArray(catalog.modules)) throw new Error("catalog.json: expected {modules, contributions}");
  if (intents.version !== 1 || !Array.isArray(intents.intents)) throw new Error("intents.json: expected {version: 1, intents}");
  return { catalog, intents, index: compactPresetIndex(catalog) };
}
