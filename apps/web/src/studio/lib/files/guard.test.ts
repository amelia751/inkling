import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginLocalOp, hasPendingOp, lastLocalOp, loadIsCurrent, resetGuard, setGuardClock, shouldApplyLoad } from "./guard";

describe("refresh guard (kiwifs shouldApplyTreeLoad, per folder)", () => {
  let now = 0;
  beforeEach(() => {
    resetGuard();
    now = 100;
    setGuardClock(() => now);
  });
  afterEach(() => setGuardClock(null));

  it("applies anything when there was no local change", () => {
    expect(shouldApplyLoad({ requestStartedAt: 1, lastLocalMutationAt: 0 })).toBe(true);
    expect(loadIsCurrent("p", "f", 1)).toBe(true);
  });

  it("ignores loads that started before the last local change to that folder only", () => {
    const started = now; // a load in flight
    now = 110;
    const settle = beginLocalOp("p", ["f1"]);
    expect(hasPendingOp("p", "f1")).toBe(true);
    expect(loadIsCurrent("p", "f1", started)).toBe(false);
    expect(loadIsCurrent("p", "f2", started)).toBe(true);
    // While the server works, even a fresh load would roll the optimistic view back.
    now = 115;
    expect(loadIsCurrent("p", "f1", 115)).toBe(false);
    now = 120;
    settle();
    expect(hasPendingOp("p", "f1")).toBe(false);
    expect(lastLocalOp("p", "f1")).toBe(120);
    expect(loadIsCurrent("p", "f1", 115)).toBe(false);
    expect(loadIsCurrent("p", "f1", 120)).toBe(true);
    expect(loadIsCurrent("p", "f1", 130)).toBe(true);
  });

  it("counts overlapping ops; settling twice is harmless", () => {
    const a = beginLocalOp("p", ["f"]);
    const b = beginLocalOp("p", ["f", "f"]);
    a();
    a();
    expect(hasPendingOp("p", "f")).toBe(true);
    b();
    expect(hasPendingOp("p", "f")).toBe(false);
  });

  it("keys by project", () => {
    beginLocalOp("p1", ["f"]);
    expect(hasPendingOp("p2", "f")).toBe(false);
  });
});
