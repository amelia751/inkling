import { describe, expect, it } from "vitest";
import { emptyOnThisItem } from "./onThisItem";

describe("emptyOnThisItem", () => {
  it("names the next action, with the digit keys for the label count", () => {
    expect(emptyOnThisItem("item", 2)).toBe("Nothing labelled on this item yet. Pick a label, or press 1–2.");
    expect(emptyOnThisItem("case", 1)).toBe("Nothing labelled on this case yet. Pick a label, or press 1.");
    expect(emptyOnThisItem("item", 14)).toBe("Nothing labelled on this item yet. Pick a label, or press 1–9.");
    expect(emptyOnThisItem("clip", 0)).toBe("Nothing labelled on this clip yet. Pick a label.");
  });
});
