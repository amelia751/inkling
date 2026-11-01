import { describe, expect, it } from "vitest";
import type { DatasetCollection, DatasetProfile } from "@studio/contracts/types";
import { applyStructure, confirmCollections, pendingSuggestions, structureFromProfile } from "./structure";

const col = (over: Partial<DatasetCollection>): DatasetCollection => ({
  id: "kind:image",
  name: "Images",
  kind: "image",
  count: 3,
  unit: { one: "image", other: "images" },
  files: 3,
  formats: [{ label: "PNG", count: 3 }],
  facts: [],
  fields: [{ id: "fact:size", name: "Image size", type: "text", unit: "px", required: true, filled: 1, source: "inspection" }],
  previewNodeId: null,
  suggested: true,
  issues: 0,
  ...over,
});
const profile: DatasetProfile = {
  datasetId: "d",
  snapshot: { kind: "draft", label: "Working draft", readOnly: false },
  files: 4,
  checking: 0,
  collections: [col({}), col({ id: "kind:table", kind: "table", name: "Tables", fields: [] })],
  relationships: [{ id: "rel:1", from: "kind:table", to: "kind:image", label: "", cardinality: "1:1", keys: "file → file name", status: "suggested" }],
  issues: [],
};

describe("dataset structure (todo13 D8)", () => {
  it("drafts a structure from inspection with every part suggested and stable ids", () => {
    const s = structureFromProfile(profile);
    expect(s.schemaVersion).toBe(1);
    expect(s.collections.map((c) => [c.id, c.suggested])).toEqual([["kind:image", true], ["kind:table", true]]);
    expect(s.collections[0].fields[0]).toEqual({ id: "fact:size", name: "Image size", type: "text", unit: "px", required: true, suggested: true });
    expect(s.relationships[0]).toMatchObject({ id: "rel:1", suggested: true });
  });

  it("confirms only the chosen collections and their fields", () => {
    const s = confirmCollections(structureFromProfile(profile), ["kind:image"]);
    expect(s.collections[0].suggested).toBe(false);
    expect(s.collections[0].fields.every((f) => f.suggested === false)).toBe(true);
    expect(s.collections[1].suggested).toBe(true);
  });

  it("reads the profile through the stored structure: names, confirmed parts and defined fields", () => {
    const stored = confirmCollections(structureFromProfile(profile), ["kind:image"]);
    stored.collections[0].name = "Chest X-rays";
    stored.collections[0].fields.push({ id: "f_view", name: "View", type: "category", required: false, suggested: true });
    stored.relationships[0].suggested = false;
    const p = applyStructure(profile, stored);
    expect(p.collections[0]).toMatchObject({ name: "Chest X-rays", suggested: false, count: 3 });
    expect(p.collections[0].fields.map((f) => [f.id, f.source, f.suggested])).toEqual([["fact:size", "inspection", false], ["f_view", "structure", true]]);
    expect(p.relationships[0].status).toBe("confirmed");
    expect(pendingSuggestions(p)).toEqual({ collections: 1, relationships: 0 });
    // No structure stored: the profile as inspection inferred it.
    expect(applyStructure(profile, null)).toBe(profile);
  });
});
