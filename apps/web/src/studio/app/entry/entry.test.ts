import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURES_OFF, parseFeatures, useFeatures } from "@/studio/lib/features";
import { dropTimeline, markTimeline, resetTimeline, startTimeline, timelinePayload } from "@/studio/lib/drop-timeline";
import { PROJECT_SECTIONS, visibleSections } from "@/studio/components/layout/app-layout";
import type { Picked } from "@/studio/lib/uploads/walk";
import { usePendingAsks } from "./pending-ask";
import { projectTitle } from "./start-project";

const picked = (...paths: string[]): Picked => ({ files: paths.map((relPath) => ({ relPath, file: new File(["x"], relPath.split("/").pop()!) })), skipped: 0 });

describe("todo13 §7.1 feature flags", () => {
  it("keeps the four known booleans; anything else is off", () => {
    expect(parseFeatures({ chatDrops: true, autoApply: "yes", fastPath: 1, datasetsTab: true, other: true })).toEqual({ chatDrops: true, autoApply: false, fastPath: false, datasetsTab: true });
    expect(parseFeatures(null)).toEqual(FEATURES_OFF);
  });
  it("starts with every flag off (the product as before todo13, J12)", () => {
    expect(useFeatures.getState()).toMatchObject({ ...FEATURES_OFF, loaded: false });
  });
});

describe("todo13 D10 sidebar", () => {
  it("says Files for the drive, keeping its section id", () => {
    expect(PROJECT_SECTIONS.map((s) => s.label)).toEqual(["Overview", "Files", "Datasets", "Studio", "Review", "Activity"]);
    expect(PROJECT_SECTIONS.find((s) => s.label === "Files")?.section).toBe("sources");
  });
  it("shows Datasets only with the datasets tab flag", () => {
    expect(visibleSections({ datasetsTab: false }).map((s) => s.section)).not.toContain("datasets");
    expect(visibleSections({ datasetsTab: true }).map((s) => s.section)).toContain("datasets");
  });
});

describe("todo13 D1 project titles", () => {
  it("come from the goal", () => {
    expect(projectTitle({ goal: "Help me classify chest X-rays." })).toBe("Classify chest X-rays");
  });
  it("come from what the files are, never their names (D3)", () => {
    expect(projectTitle({ picked: picked("Smith_John/a.png", "Smith_John/b.png") })).toBe("2 images");
    expect(projectTitle({ picked: picked("Smith_John_1962-04-03.dcm") })).toBe("1 DICOM image");
    expect(projectTitle({ picked: picked("a.png", "notes.pdf") })).toBe("2 files");
    expect(projectTitle({})).toBe("New project");
  });
});

describe("pending ask (Home's first send)", () => {
  it("is taken once", () => {
    usePendingAsks.getState().queue("p1", "Segment liver CT");
    expect(usePendingAsks.getState().take("p1")).toEqual({ text: "Segment liver CT" });
    expect(usePendingAsks.getState().take("p1")).toBeUndefined();
  });
  it("carries a drop already started in the conversation (Home's drop)", () => {
    usePendingAsks.getState().queue("p1", "", { dropId: "drp-1", messageId: "m-1" });
    expect(usePendingAsks.getState().take("p1")).toEqual({ text: "", drop: { dropId: "drp-1", messageId: "m-1" } });
  });
});

describe("drop timeline (todo13 Milestone 4 item 1)", () => {
  afterEach(() => resetTimeline());
  it("marks steps once, relative to the gesture, and reports durations only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    startTimeline("home");
    markTimeline("project-created");
    markTimeline("project-created");
    const t = dropTimeline();
    expect(t.origin).toBe("home");
    expect(t.steps.map((s) => s.step)).toEqual(["gesture", "project-created"]);
    expect(t.steps.every((s) => s.ms >= 0)).toBe(true);
    markTimeline("first-interactive");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.origin).toBe("home");
    expect(body.outcome).toBe("interactive");
    expect(Object.keys(body.steps)).toEqual(["gesture", "project-created", "first-interactive"]);
    expect(Object.values(body.steps).every((v) => typeof v === "number")).toBe(true);
    markTimeline("later");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
  it("ignores marks without a timeline", () => {
    markTimeline("first-interactive");
    expect(dropTimeline().steps).toEqual([]);
  });
  it("builds the api's body", () => {
    expect(timelinePayload({ active: true, origin: "canvas", dropId: "drp_1", steps: [{ step: "gesture", ms: 0 }], reported: false }, "abandoned")).toEqual({ dropId: "drp_1", origin: "canvas", outcome: "abandoned", steps: { gesture: 0 } });
  });
});
