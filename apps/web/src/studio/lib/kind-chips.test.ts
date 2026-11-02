import { describe, expect, it } from "vitest";
import { kindChips } from "./kind-chips";

describe("kindChips", () => {
  it("one chip per kind with counts, in first-seen order", () => {
    expect(kindChips(["image", "ecg", "image", null])).toEqual([{ kind: "image", count: 2 }, { kind: "ecg", count: 1 }, { kind: "", count: 1 }]);
  });
  it("no chips when the Studio has one kind", () => {
    expect(kindChips(["image", "image"])).toEqual([]);
  });
});
