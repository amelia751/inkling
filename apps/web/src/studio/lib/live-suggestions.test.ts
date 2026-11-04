import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation } from "@studio/contracts/types";
import { followSuggestions, newSuggestions, POLL, pullSuggestions } from "./live-suggestions";
import { useStudio } from "@/studio/stores/studio";
import { useSaveConflicts } from "@/studio/lib/annotation-merge";

const ann = (id: string, provenance: Annotation["provenance"] = "ai-suggested", itemId = "a.png"): Annotation => ({
  id,
  itemId,
  label: "right lung",
  geometry: { type: "mask", dims: [2, 2], counts: [0, 4] },
  provenance,
  author: "plugin:seg@1",
  createdAt: "2026-11-04T00:00:00Z",
  attributes: { review_status: "pending" },
});

describe("newSuggestions", () => {
  it("adds only AI suggestions the store hasn't seen and the person didn't remove", () => {
    const local = [ann("m1")];
    const base = [ann("m1"), ann("gone")];
    const server = [ann("m1"), ann("gone"), ann("m2"), ann("h1", "human-created")];
    expect(newSuggestions(local, base, server).map((a) => a.id)).toEqual(["m2"]);
  });
});

describe("pullSuggestions", () => {
  beforeEach(() => {
    useStudio.getState().load("p1", [ann("m1")], 3, null);
    useSaveConflicts.getState().setBase("p1", [ann("m1")]);
  });

  it("merges new masks without dirtying the Studio or adding an undo step, and takes the server revision", async () => {
    const n = await pullSuggestions("p1", async () => ({ revision: 5, annotations: [ann("m1"), ann("m2"), ann("m3", "ai-suggested", "b.png")] }));
    expect(n).toBe(2);
    const s = useStudio.getState();
    expect(s.annotations.map((a) => a.id)).toEqual(["m1", "m2", "m3"]);
    expect(s).toMatchObject({ dirty: false, revision: 5 });
    expect(s.past).toHaveLength(0);
    expect(useSaveConflicts.getState().base.map((a) => a.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("keeps unsaved edits and the local revision (the save's merge reconciles it)", async () => {
    useStudio.getState().add(ann("h1", "human-created"));
    await pullSuggestions("p1", async () => ({ revision: 5, annotations: [ann("m1"), ann("m2")] }));
    const s = useStudio.getState();
    expect(s.annotations.map((a) => a.id)).toEqual(["m1", "h1", "m2"]);
    expect(s).toMatchObject({ dirty: true, revision: 3 });
  });

  it("ignores a document for another Studio", async () => {
    expect(await pullSuggestions("other", async () => ({ revision: 9, annotations: [ann("x")] }))).toBe(0);
  });
});

describe("followSuggestions", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(active: () => boolean, withJobs = true) {
    const pull = vi.fn(async () => 0);
    const subs = new Map<string, () => void>();
    const stop = followSuggestions({
      pull,
      hasActiveJobs: withJobs ? async () => active() : undefined,
      subscribe: (t, fn) => (subs.set(t, fn), () => subs.delete(t)),
    });
    return { pull, subs, stop };
  }

  it("pulls at once on annotations.committed and job.succeeded", () => {
    const { pull, subs, stop } = setup(() => false, false);
    subs.get("annotations.committed")!();
    subs.get("job.succeeded")!();
    expect(pull).toHaveBeenCalledTimes(2);
    stop();
    expect(subs.size).toBe(0);
  });

  it("polls fast while jobs run, pulls once more when they stop, then backs off", async () => {
    let running = true;
    const { pull, stop } = setup(() => running);
    await vi.advanceTimersByTimeAsync(POLL.activeMs);
    expect(pull).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL.activeMs * 1.5);
    expect(pull).toHaveBeenCalledTimes(2);
    running = false;
    await vi.advanceTimersByTimeAsync(POLL.activeMaxMs);
    expect(pull).toHaveBeenCalledTimes(3); // the last job's masks
    await vi.advanceTimersByTimeAsync(POLL.idleMaxMs * 3);
    expect(pull).toHaveBeenCalledTimes(3); // idle: checks jobs, doesn't pull
    stop();
  });
});
