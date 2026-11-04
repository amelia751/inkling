import { describe, expect, it } from "vitest";
import { phaseFor, settledPhase, trayLine, type TraySession } from "./uploads";
import { fileRowText } from "@/studio/components/uploads/uploads";

const file = (state: TraySession["files"][number]["state"], i: number) => ({ clientFileId: `f${i}`, relPath: `${i}.avi`, size: 1, received: 0, state, reason: null });
const totals = (incomplete?: boolean) => ({ files: 4, bytes: 4, receivedBytes: 4, byState: {}, ...(incomplete === undefined ? {} : { incomplete }) });

describe("todo24 D5 an honest upload tray", () => {
  it("a finished import that left files behind is partial, never done", () => {
    expect(phaseFor({ state: "ready", totals: totals(true) }, "checking")).toBe("partial");
    expect(phaseFor({ state: "needs_review", totals: totals(true) }, "checking")).toBe("partial");
    // Even without the flag, pending rows on a finished import mean it's partial.
    expect(phaseFor({ state: "ready", totals: totals(), files: [file("uploaded", 0), file("pending", 1)] as never }, "checking")).toBe("partial");
    expect(phaseFor({ state: "ready", totals: totals(false), files: [file("uploaded", 0)] as never }, "checking")).toBe("done");
  });

  it("keeps the other states", () => {
    expect(phaseFor({ state: "inspecting", totals: totals(true) }, "uploading")).toBe("checking");
    expect(phaseFor({ state: "uploading", totals: totals() }, "uploading")).toBe("uploading");
    expect(phaseFor({ state: "uploading", totals: totals() }, "preparing")).toBe("failed");
    expect(phaseFor({ state: "failed", totals: totals() }, "uploading")).toBe("failed");
    expect(phaseFor({ state: "cancelled", totals: totals() }, "uploading")).toBe("cancelled");
  });

  it("says how many arrived, and unsent files read Not uploaded once nothing is moving", () => {
    const files = [file("uploaded", 0), file("skipped_duplicate", 1), file("pending", 2), file("pending", 3)];
    const s: TraySession = { key: "u", projectId: "p", title: "6-pathology-slide", phase: "partial", total: 4, prepared: 4, skippedJunk: 0, files, importId: "imp" };
    expect(trayLine(s)).toBe("2 of 4 uploaded");
    for (const phase of ["done", "partial", "failed", "cancelled"] as const) {
      expect(settledPhase(phase)).toBe(true);
      expect(fileRowText({ phase }, { state: "pending", reason: null })).toBe("Not uploaded");
    }
    for (const phase of ["uploading", "checking", "preparing"] as const) expect(fileRowText({ phase }, { state: "pending", reason: null })).toBe("Waiting");
  });
});
