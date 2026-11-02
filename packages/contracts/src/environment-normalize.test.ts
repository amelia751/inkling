import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvironmentSpecSchema, normalizeEnvironment } from "./environment";

const dir = join(import.meta.dirname, "../../../registry/presets");
const presets = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("normalizeEnvironment over every preset (todo19 D3)", () => {
  it("finds presets", () => expect(presets.length).toBeGreaterThan(0));
  for (const file of presets) {
    const spec = EnvironmentSpecSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")).spec);
    it(`${file}: idempotent, schema-valid, keeps data.kind and viewports`, () => {
      const once = normalizeEnvironment(spec);
      expect(normalizeEnvironment(once)).toEqual(once);
      expect(EnvironmentSpecSchema.parse(once)).toEqual(once);
      expect(once.data?.kind).toBe(spec.data?.kind);
      expect(once.viewports).toEqual(spec.viewports);
      if (spec.data?.kind) {
        const p = once.data!.kinds![spec.data.kind];
        expect(p).toBeDefined();
        if (spec.viewports?.length) expect(p.renderer).toBe(spec.viewports[0].renderer);
        expect(once.accepts).toContain(spec.data.kind);
      }
    });
  }
});
