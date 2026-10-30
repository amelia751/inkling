import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/bundle";
import { MIGRATED_V1_TYPES } from "@/lib/api";
import { migrateDocument } from "@/migrations/annotations-v1-to-v2";
import { registry } from "@/platform/registry";
import { resolveEnvironment } from "@/platform/resolve";
import { clearRuntime } from "@/platform/runtime";
import type { ExporterImpl } from "@/platform/module";
import golden from "./__fixtures__/export-golden.json";
import { items, normaliseJson, project, stubFetch, untar, v1Annotations } from "./__fixtures__/exportCase";
import { NS } from "@studio/plugin-contracts/naming";

/**
 * Byte identity across the geometry migration: the v2 exporters, run on the migrated v1
 * annotations, write exactly what the v1 exporters wrote for them (export-golden.json was
 * produced by the pre-migration `viewers/signal/exporters.ts` from the same fixture).
 */
describe("timeseries exporters (v1 → v2 byte identity)", () => {
  const migrated = migrateDocument({ revision: 1, annotations: v1Annotations }, MIGRATED_V1_TYPES).annotations;
  const env = resolveEnvironment({ extends: "preset:ecg" }, registry).env!;
  const run = async (id: string, withEnv: boolean) => {
    const e = await registry.loadImpl<ExporterImpl>(`${NS}.timeseries.exporters.${id}`);
    const blob = await e.build({ project, items, annotations: migrated, env: withEnv ? env : undefined });
    return { name: e.filename(project), bytes: new Uint8Array(await blob.arrayBuffer()) };
  };
  beforeEach(() => {
    vi.stubGlobal("fetch", stubFetch());
    clearRuntime();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("migrates every v1 strip-chart geometry to span / instant", () => {
    expect(migrated.every((a) => ["span", "instant", "class"].includes(a.geometry.type))).toBe(true);
  });

  for (const withEnv of [true, false]) {
    it(`WFDB .atr / wave files / header / RECORDS are identical (${withEnv ? "shell env" : "project env"})`, async () => {
      const { name, bytes } = await run("wfdb-atr", withEnv);
      expect(name).toBe(golden["wfdb-atr:filename"]);
      expect(untar(bytes)).toEqual(golden["wfdb-atr"]);
    });
  }

  it("LUDB JSON is identical apart from the export time", async () => {
    const { name, bytes } = await run("ecg-json", true);
    expect(name).toBe(golden["ecg-json:filename"]);
    expect(normaliseJson(new TextDecoder().decode(bytes))).toBe(golden["ecg-json"]);
  });

  it("intervals CSV is identical", async () => {
    const { name, bytes } = await run("ecg-intervals-csv", true);
    expect(name).toBe(golden["ecg-intervals-csv:filename"]);
    expect(new TextDecoder().decode(bytes)).toBe(golden["ecg-intervals-csv"]);
  });
});
