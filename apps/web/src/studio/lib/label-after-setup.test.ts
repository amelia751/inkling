import { describe, expect, it } from "vitest";
import { labelAfterSetupChange } from "./live-environment";

describe("labelAfterSetupChange (todo18 §2 C)", () => {
  it("keeps a label that's still there", () => expect(labelAfterSetupChange("a", ["a", "b"])).toEqual({ active: "a", removed: null }));
  it("falls back to the first label when the active one was removed", () => expect(labelAfterSetupChange("x", ["a", "b"])).toEqual({ active: "a", removed: "x" }));
  it("clears it when no labels are left", () => expect(labelAfterSetupChange("x", [])).toEqual({ active: null, removed: "x" }));
});
