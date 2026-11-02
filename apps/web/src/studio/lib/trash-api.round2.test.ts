import { describe, expect, it } from "vitest";
import { allFilesInTrash, isTrashedItem, trashedMatchesLine, usedByLine } from "./trash-api";

describe("trash round 2 helpers", () => {
  it("says which datasets a file delete takes items from", () => {
    expect(usedByLine([])).toBe("");
    expect(usedByLine([{ id: "a", name: "Chest CT", items: 1 }])).toBe("Used by Chest CT (1 item)");
    expect(usedByLine([{ id: "a", name: "A", items: 300 }, { id: "b", name: "B", items: 40 }])).toBe("Used by 2 datasets (340 items)");
  });
  it("spots trashed items and datasets whose files are all in Trash", () => {
    expect(isTrashedItem({ state: "trashed" })).toBe(true);
    expect(isTrashedItem({ state: "todo" })).toBe(false);
    expect(isTrashedItem(null)).toBe(false);
    expect(allFilesInTrash({ filesInTrash: 3, itemCount: 0 })).toBe(true);
    expect(allFilesInTrash({ filesInTrash: 2, itemCount: 3 })).toBe(false);
    expect(allFilesInTrash({ filesInTrash: 2 })).toBe(false);
    expect(allFilesInTrash({})).toBe(false);
  });
  it("counts search matches in Trash", () => {
    expect(trashedMatchesLine(0)).toBe("");
    expect(trashedMatchesLine(1)).toBe("1 match in Trash");
    expect(trashedMatchesLine(12)).toBe("12 matches in Trash");
  });
});
