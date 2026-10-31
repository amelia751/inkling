import { describe, expect, it } from "vitest";
import { emptyOnThisItem } from "./onThisItem";

describe("emptyOnThisItem", () => {
  it("names the next action, with the digit keys for the label count", () => {
    expect(emptyOnThisItem("image", 2)).toBe("No annotations on this image. Pick a label and draw, or press 1–2.");
    expect(emptyOnThisItem("slide", 1)).toBe("No annotations on this slide. Pick a label and draw, or press 1.");
    expect(emptyOnThisItem("study", 14)).toBe("No annotations on this study. Pick a label and draw, or press 1–9.");
    expect(emptyOnThisItem("recording", 0)).toBe("No annotations on this recording. Pick a label and draw.");
  });
});
