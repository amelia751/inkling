import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWrite, type CheckInput } from "./validate.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const schema = JSON.parse(readFileSync(resolve(ROOT, "schemas/environment.v1.json"), "utf8"));
const { cases } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../fixtures/cases.json"), "utf8")) as {
  cases: (Omit<CheckInput, "schema"> & { name: string; expect: { status: number; errors: { path: string; code: string }[] } })[];
};

const key = (e: { path: string; code: string }) => `${e.code} ${e.path}`;

describe("conformance fixtures (the API runs the same cases)", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = checkWrite({ ...c, schema });
    expect(r.status).toBe(c.expect.status);
    expect(r.errors.map(key).sort()).toEqual(c.expect.errors.map(key).sort());
  });
});

describe("the bundled presets are valid documents", () => {
  const presets = readdirSync(resolve(ROOT, "registry/presets")).filter((f) => f.endsWith(".json") && f !== "intents.json");
  it.each(presets)("%s", (f) => {
    const preset = JSON.parse(readFileSync(resolve(ROOT, "registry/presets", f), "utf8"));
    expect(checkWrite({ schema, principal: "person", environment: preset.spec }).errors).toEqual([]);
    expect(checkWrite({ schema, principal: "person", environment: { extends: `preset:${f.replace(/\.json$/, "")}` } }).errors).toEqual([]);
  });
});
