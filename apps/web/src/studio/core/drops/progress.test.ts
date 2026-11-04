import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropCounts, dropHeadline, kindPlural, waitingText, type ChipState } from "./progress";
import { chipText, summaryState } from "./drop-card";
import { dropPollInterval, POLL_MS, POLL_WITH_EVENTS_MS } from "./hooks";
import { keyedThrottle } from "./throttle";
import { joinsStudio } from "./live";

const chips = (spec: Partial<Record<ChipState, number>>, kind?: string) => Object.entries(spec).flatMap(([state, n]) => Array.from({ length: n! }, () => ({ state: state as ChipState, kind })));

describe("todo28 D8: the drop card's headline comes from counts", () => {
  it("says where the files are, never one Checking for the drop", () => {
    expect(dropHeadline(dropCounts(chips({ in_studio: 12, checking: 22, kept: 1 })))).toBe("12 in the Studio · 22 checking · 1 kept in Sources");
    expect(dropHeadline(dropCounts([...chips({ uploading: 2, checking: 1 }), ...chips({ waiting_kind: 3 }, "video")]))).toBe("2 uploading · 1 checking · 3 waiting for the assistant to add videos");
    expect(dropHeadline(dropCounts(chips({ failed: 1, duplicate: 2, removed: 4 })))).toBe("2 already in Sources · 1 failed");
    expect(dropHeadline(dropCounts([]))).toBe("Nothing to share");
  });

  it("says Waiting for you to confirm while the rights dialog is open, not Preparing", () => {
    expect(dropHeadline(dropCounts(chips({ confirming: 3 })))).toBe("Waiting for you to confirm");
    expect(summaryState(chips({ confirming: 3 }))).toBe("confirming");
  });

  it("takes the summary's counts when the file states don't carry them (an older file list)", () => {
    const c = dropCounts(chips({ ready: 5, checking: 2 }), { inStudio: 3, waitingForKind: { video: 1 } });
    expect(dropHeadline(c)).toBe("3 in the Studio · 1 ready · 2 checking · 1 waiting for the assistant to add videos");
    expect(dropHeadline(dropCounts(chips({ checking: 2 }), {}))).toBe("2 checking");
  });

  it("calls a drop with ready files and files still moving `filling`, not `checking`", () => {
    expect(summaryState(chips({ in_studio: 1, checking: 4 }))).toBe("filling");
    expect(summaryState(chips({ checking: 4 }))).toBe("checking");
    expect(summaryState(chips({ in_studio: 4 }))).toBe("ready");
  });

  it("a retrying file and a file waiting for its kind say so", () => {
    expect(chipText({ state: "checking", retrying: true })).toBe("Still checking (retrying)");
    expect(chipText({ state: "checking" })).toBe("Checking");
    expect(chipText({ state: "waiting_kind", kind: "video" })).toBe("Waiting for the assistant to add videos");
    expect(chipText({ state: "in_studio" })).toBe("In the Studio");
  });

  it("names a kind as a plural noun, domain-neutral", () => {
    expect(kindPlural("video")).toBe("videos");
    expect(kindPlural("dicom-series")).toBe("dicom series");
    expect(kindPlural("audio")).toBe("audio files");
    expect(kindPlural("whole_slide")).toBe("whole slides");
    expect(kindPlural("box")).toBe("boxes");
    expect(waitingText(null)).toBe("Waiting for the assistant to add files");
  });
});

describe("todo28 W4: one poller per drop, at most 1 request/s", () => {
  it("polls only while files move, and rarely once the stream carries events", () => {
    const moving = { files: [{ state: "checking" }, { state: "in_studio" }] } as never;
    const settled = { files: [{ state: "in_studio" }, { state: "kept" }, { state: "failed" }] } as never;
    expect(dropPollInterval(moving, false)).toBe(POLL_MS);
    expect(dropPollInterval(moving, true)).toBe(POLL_WITH_EVENTS_MS);
    expect(dropPollInterval(settled, false)).toBe(false);
    expect(dropPollInterval(undefined, false)).toBe(POLL_MS);
  });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses a burst of refreshes per drop into one now and one at the end of the second", () => {
    const t = keyedThrottle(1000);
    const calls: string[] = [];
    for (let i = 0; i < 30; i++) t("drp-a", () => calls.push(`a${i}`));
    t("drp-b", () => calls.push("b"));
    expect(calls).toEqual(["a0", "b"]);
    vi.advanceTimersByTime(999);
    expect(calls).toEqual(["a0", "b"]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["a0", "b", "a29"]);
    vi.advanceTimersByTime(5000);
    t("drp-a", () => calls.push("later"));
    expect(calls.at(-1)).toBe("later");
  });
});

describe("todo28 W4: the open Studio grows as files join", () => {
  it("refreshes on its own task's routing events, not another Studio's", () => {
    expect(joinsStudio("drop.file", { dropId: "d", taskId: "tsk-1", state: "in_studio" }, "tsk-1")).toBe(true);
    expect(joinsStudio("drop.file", { dropId: "d", taskId: "tsk-2", state: "in_studio" }, "tsk-1")).toBe(false);
    expect(joinsStudio("drop.file", { dropId: "d", taskId: "tsk-1", state: "checking" }, "tsk-1")).toBe(false);
    expect(joinsStudio("source.node.inspected", { nodeId: "n" }, "tsk-1")).toBe(true);
    expect(joinsStudio("source.node.inspected", { nodeId: "n", taskId: "tsk-2" }, "tsk-1")).toBe(false);
    expect(joinsStudio("drop.applied", { taskIds: ["tsk-1"] }, "tsk-1")).toBe(true);
    expect(joinsStudio("drop.applied", { taskIds: ["tsk-9"] }, "tsk-1")).toBe(false);
  });
});
