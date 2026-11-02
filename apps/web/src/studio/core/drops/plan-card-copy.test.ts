import { describe, expect, it } from "vitest";
import { ApiError } from "@/studio/lib/projects-api";
import { isFollowUp, undoBlockedReason } from "./PlanCard";

describe("todo18 plan card copy", () => {
  it("shows the kernel's reason when Undo is blocked", () => {
    expect(undoBlockedReason(new ApiError(409, "a Studio this drop made already has annotations: undo isn't safe any more"))).toMatch(/already has annotations/);
    expect(undoBlockedReason(new ApiError(409, "a Studio this drop made was published"))).toMatch(/was published/);
  });
  it("knows a follow-up plan", () => {
    expect(isFollowUp("drp-0a1b2c-3")).toBe(true);
    expect(isFollowUp("drp-0a1b2c")).toBe(false);
  });
});
