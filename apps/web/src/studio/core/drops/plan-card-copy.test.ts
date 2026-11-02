import { describe, expect, it } from "vitest";
import { ApiError } from "@/studio/lib/projects-api";
import { appliedCopy, isFollowUp, undoBlockedReason } from "./PlanCard";

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

describe("todo20 applied drop copy", () => {
  it("says where the files went and how many were already here", () => {
    expect(appliedCopy({ outcome: "add_to_studio", newCount: 35, alreadyHere: 0 })).toEqual({ headline: "Added 35 files to Studio", open: "Open" });
    expect(appliedCopy({ outcome: "add_to_studio", newCount: 0, alreadyHere: 35 })?.headline).toBe("Already in this project");
    expect(appliedCopy({ outcome: "add_to_studio", newCount: 0, alreadyHere: 35 })?.open).toBe("Open in Studio");
    expect(appliedCopy({ outcome: "add_to_studio", newCount: 12, alreadyHere: 23 })?.detail).toBe("12 new, 23 already here");
    expect(appliedCopy({ outcome: null, newCount: 1 })).toBeNull();
  });
});
