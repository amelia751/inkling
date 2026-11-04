import { afterEach, describe, expect, it } from "vitest";
import { dropTimeline, noteDropProgress, onServerEvent, resetTimeline, startTimeline } from "./drop-timeline";

const steps = () => dropTimeline().steps.map((s) => s.step);

describe("todo28: the drop timeline records the first item in the Studio and the drop settled", () => {
  afterEach(() => resetTimeline());

  it("from the drop's events, for the timeline's own drop only", () => {
    startTimeline("chat", { dropId: "drp-1" });
    onServerEvent("drop.file", { dropId: "drp-2", state: "in_studio" });
    expect(steps()).not.toContain("drop:first-in-studio");
    onServerEvent("drop.file", { dropId: "drp-1", state: "checking" });
    expect(steps()).not.toContain("drop:first-in-studio");
    onServerEvent("drop.file", { dropId: "drp-1", state: "in_studio" });
    onServerEvent("drop.settled", { dropId: "drp-1" });
    expect(steps()).toEqual(expect.arrayContaining(["gesture", "server:drop.file", "drop:first-in-studio", "drop:settled"]));
  });

  it("from the fetched drop: first file in the Studio, then every file ended", () => {
    startTimeline("chat", { dropId: "drp-1" });
    noteDropProgress({ id: "drp-1", files: [{ state: "checking" }, { state: "checking" }] });
    expect(steps()).toEqual(["gesture"]);
    noteDropProgress({ id: "drp-1", files: [{ state: "in_studio" }, { state: "checking" }] });
    expect(steps()).toContain("drop:first-in-studio");
    expect(steps()).not.toContain("drop:settled");
    noteDropProgress({ id: "drp-1", files: [{ state: "in_studio" }, { state: "failed" }] });
    expect(steps()).toContain("drop:settled");
  });

  it("does nothing without a timeline", () => {
    noteDropProgress({ id: "drp-1", files: [{ state: "in_studio" }] });
    expect(dropTimeline().steps).toEqual([]);
  });
});
