import { afterEach, describe, expect, it } from "vitest";
import { applyRuntimeConfig } from "@/extension-host/runtime-config";
import { INSPECTION_GIVE_UP_MS, INSPECTION_STALLED_REASON, inspectionStatus, trayLine, type TraySession } from "./uploads";

const session = (p: Partial<TraySession>): TraySession => ({ key: "k", projectId: "p", title: "t", phase: "checking", total: 1, prepared: 1, skippedJunk: 0, files: [], ...p });

describe("todo15 D5 upload inspection stall", () => {
  afterEach(() => applyRuntimeConfig(null));

  it("says checking until the stall time (default 120 s), then stalled, then gives up at 10 minutes", () => {
    applyRuntimeConfig(null);
    expect(inspectionStatus(0, 119_999)).toBe("checking");
    expect(inspectionStatus(0, 120_000)).toBe("stalled");
    expect(inspectionStatus(0, INSPECTION_GIVE_UP_MS - 1)).toBe("stalled");
    expect(inspectionStatus(0, INSPECTION_GIVE_UP_MS)).toBe("timedOut");
  });

  it("reads the stall time from the runtime config", () => {
    expect(applyRuntimeConfig({ inspectionStallSeconds: 30 }).inspectionStallSeconds).toBe(30);
    expect(inspectionStatus(0, 29_999)).toBe("checking");
    expect(inspectionStatus(0, 30_000)).toBe("stalled");
    expect(applyRuntimeConfig({ inspectionStallSeconds: -1 }).inspectionStallSeconds).toBe(120);
  });

  it("tells the person when checking is slow, and why it failed", () => {
    expect(trayLine(session({}))).toBe("Checking files");
    expect(trayLine(session({ stalled: true }))).toBe("Still checking. Inspection is slow or unavailable");
    expect(trayLine(session({ phase: "failed", error: INSPECTION_STALLED_REASON }))).toBe(INSPECTION_STALLED_REASON);
  });
});
