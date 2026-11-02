import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import { registry } from "./registry";
import { resolveEnvironment } from "./resolve";
import "@/extension-host/bundled";

/**
 * todo17 D2: the API ports the resolver's deterministic checks
 * (apps/api/src/studio_api/kernel/environment_resolve.py). Both run these fixtures and must
 * report the same (code, path) pairs among the ported codes.
 */
const PORTED = new Set(["extends-cycle", "wrong-type", "missing-data-kind", "missing-viewport", "renderer-data-mismatch", "duplicate-tool", "label-target", "exporter-unused"]);
const file = resolvePath(import.meta.dirname, "../../../../packages/environment-core/fixtures/resolve-cases.json");
const { cases } = JSON.parse(readFileSync(file, "utf8")) as { cases: { name: string; environment: unknown; expect: { code: string; path: string }[] }[] };
const key = (e: { code: string; path: string }) => `${e.code} ${e.path}`;

describe("resolve conformance fixtures (the API runs the same cases)", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const r = resolveEnvironment(c.environment, registry);
    const got = (r.errors ?? []).filter((e) => PORTED.has(e.code)).map(key).sort();
    expect(got).toEqual(c.expect.map(key).sort());
  });
});
