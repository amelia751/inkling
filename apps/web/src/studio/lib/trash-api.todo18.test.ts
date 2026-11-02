import { describe, expect, it } from "vitest";
import { emptyTrashUrl } from "./files/api";
import { emptyCountsLine, groupByBatch, type ProjectTrashItem } from "./trash-api";

const item = (batchId: string, name: string, kind: ProjectTrashItem["kind"] = "source"): ProjectTrashItem => ({
  batchId,
  kind,
  id: `${batchId}-${name}`,
  name,
  originalLocation: null,
  trashedAt: "2026-11-01T00:00:00Z",
  trashedBy: { id: "user:a", name: "a", viaAssistant: false },
  daysLeft: 30,
  dependents: {},
});

describe("todo18 trash", () => {
  it("Sources › Trash empties files only (P0-1)", () => {
    expect(emptyTrashUrl("p1")).toBe("/projects/p1/trash/empty?kind=sources");
    expect(emptyTrashUrl("p1", true)).toBe("/projects/p1/trash/empty/preview?kind=sources");
  });
  it("lists what Empty trash takes per kind", () => {
    expect(emptyCountsLine([])).toBe("Nothing");
    expect(emptyCountsLine([item("b1", "a"), item("b1", "b"), item("b2", "Scans", "dataset"), item("b3", "S", "studio")])).toBe("2 files and folders, 1 dataset and 1 Studio");
  });
  it("shows one row per batch", () => {
    const g = groupByBatch([item("b1", "pneumonia"), ...[1, 2, 3, 4, 5].map((i) => item("b1", `x${i}`)), item("b2", "Scans", "dataset")]);
    expect(g.map((x) => x.batchId)).toEqual(["b1", "b2"]);
    expect(g[0]!.label).toBe("pneumonia and 5 more");
    expect(g[0]!.members).toHaveLength(6);
    expect(g[1]!.label).toBe("Scans");
  });
});
