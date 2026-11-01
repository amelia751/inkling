import { describe, expect, it } from "vitest";
import { DatasetStructure, emptyStructure } from "./dataset-structure";
import { DropPlan } from "./drop-plan";

describe("DatasetStructure v1 (todo13 D8)", () => {
  const good = {
    schemaVersion: 1,
    collections: [
      { id: "col-xray", name: "Chest X-rays", kind: "image", formats: ["PNG"], fields: [{ id: "fact:width", name: "Width", type: "integer", unit: "px", required: true, suggested: true }], suggested: true },
      { id: "col-labels", name: "Labels table", kind: "table", formats: ["CSV"], fields: [{ id: "col:image_id", name: "image_id", type: "id", required: true }] },
    ],
    relationships: [{ id: "rel-1", from: "col-labels", to: "col-xray", cardinality: "1:1", keys: ["col:image_id", "name"], suggested: true }],
    annotations: [{ id: "ann-finding", collectionId: "col-xray", geometry: "class", labels: [{ id: "normal", name: "Normal" }, { id: "pneumonia", name: "Pneumonia", color: "#ff0000" }], suggested: true }],
  };

  it("accepts a structure with stable ids", () => {
    expect(DatasetStructure.parse(good)).toEqual(good);
    expect(DatasetStructure.parse(emptyStructure()).collections).toEqual([]);
  });

  it("refuses unknown fields, duplicate ids and dangling references", () => {
    expect(DatasetStructure.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(DatasetStructure.safeParse({ ...good, collections: [good.collections[0], good.collections[0]] }).success).toBe(false);
    expect(DatasetStructure.safeParse({ ...good, relationships: [{ ...good.relationships[0], to: "col-nope" }] }).success).toBe(false);
    expect(DatasetStructure.safeParse({ ...good, annotations: [{ ...good.annotations[0], collectionId: "col-nope" }] }).success).toBe(false);
    expect(DatasetStructure.safeParse({ ...good, schemaVersion: 2 }).success).toBe(false);
    // Ids are strings, never positions.
    expect(DatasetStructure.safeParse({ ...good, collections: [{ ...good.collections[0], id: 0 }] }).success).toBe(false);
  });
});

describe("DropPlan (todo13 §5)", () => {
  it("accepts the contract's fields and the additive ones", () => {
    const plan = {
      dropId: "drp_1",
      needsPerson: true,
      actions: [
        { groupId: "g1", type: "new_dataset", name: "Images", preset: "preset:image-2d", nodeIds: ["nod-1", "nod-2"], kind: "image", count: 2 },
        { groupId: "g2", type: "new_collection", datasetId: "ds-1", nodeIds: ["nod-3"], asks: "labels_table", relatesTo: "col-1" },
        { groupId: "g3", type: "keep_unsupported", nodeIds: ["nod-4"], findPluginKind: "unknown" },
      ],
    };
    expect(DropPlan.parse(plan)).toEqual(plan);
  });
  it("refuses an unknown action type", () => {
    expect(DropPlan.safeParse({ dropId: "d", needsPerson: false, actions: [{ groupId: "g", type: "delete", nodeIds: [] }] }).success).toBe(false);
  });
});
