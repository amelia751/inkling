import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Catalog } from "../src/catalog.ts";
import type { IntentTable } from "../src/intents.ts";

const root = resolve(import.meta.dirname, "../../..");
export const catalog = JSON.parse(readFileSync(resolve(root, "schemas/catalog.json"), "utf8")) as Catalog;
export const intents = JSON.parse(readFileSync(resolve(root, "registry/intents.json"), "utf8")) as IntentTable;
export const environmentSchema = JSON.parse(readFileSync(resolve(root, "schemas/environment.v1.json"), "utf8"));
