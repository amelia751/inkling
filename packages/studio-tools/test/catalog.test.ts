import { describe, expect, it } from "vitest";
import { compactPresetIndex, presetRef, searchCatalog } from "../src/catalog.ts";
import { catalog } from "./fixtures.ts";

describe("compactPresetIndex", () => {
  const text = compactPresetIndex(catalog);
  it("lists every preset as preset:<name> and every module, briefly", () => {
    for (const c of catalog.contributions.filter((c) => c.type === "presets")) expect(text).toContain(`- ${presetRef(c.id)}: `);
    for (const m of catalog.modules) expect(text).toContain(`- ${m.id}: `);
    expect(text).not.toContain(".presets.presets.");
    expect(text.length).toBeLessThan(6000);
  });
  it("is stable", () => {
    expect(compactPresetIndex({ ...catalog, modules: [...catalog.modules].reverse(), contributions: [...catalog.contributions].reverse() })).toBe(text);
  });
});

describe("searchCatalog", () => {
  it("finds tools by words, brief by default", () => {
    const hits = searchCatalog(catalog, "polygon tool");
    expect(hits[0]?.type).toBe("tools");
    expect(hits[0]?.id).toMatch(/\.tools\.polygon$/);
    expect(hits[0]).not.toHaveProperty("example");
    expect(hits.length).toBeLessThanOrEqual(8);
  });
  it("filters by kind and maps presets", () => {
    const hits = searchCatalog(catalog, "x-ray radiograph", { kind: "presets" });
    expect(hits[0]?.id).toBe("preset:image-2d");
    expect(hits[0]?.catalogId).toMatch(/\.presets\.image-2d$/);
    expect(hits.every((h) => h.type === "presets")).toBe(true);
  });
  it("finds exporters", () => {
    expect(searchCatalog(catalog, "COCO export", { kind: "exporters" })[0]?.id).toMatch(/exporters\.coco$/);
  });
  it("full detail carries the example and config schema", () => {
    const [hit] = searchCatalog(catalog, "cornerstone stack", { kind: "renderers", detail: "full" });
    expect(hit?.id).toMatch(/renderers\.cornerstone-stack$/);
    expect(hit?.example).toBeDefined();
    expect(hit?.more?.configSchema).toBeDefined();
  });
  it("returns nothing for stop words only or no match", () => {
    expect(searchCatalog(catalog, "the of and")).toEqual([]);
    expect(searchCatalog(catalog, "zzzqqq")).toEqual([]);
  });
});
