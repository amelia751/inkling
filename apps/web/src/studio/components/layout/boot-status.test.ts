import { describe, expect, it } from "vitest";
import { readySeconds } from "./boot-status";

describe("the Studio ready chip's duration", () => {
  const boot = { ms: 20, seenAt: 0, finishedAt: 20 };
  const idle = { active: false, dropId: null, steps: [] };
  it("times a drop's boot from the confirmed upload to boot ready, not the fast path's server ms", () => {
    const t = { active: true, dropId: "drp-1", steps: [{ step: "attested", ms: 1200 }, { step: "server:boot.ready", ms: 3600 }] };
    expect(readySeconds({ ...boot, initiator: { kind: "person", dropId: "drp-1" } as never }, t)).toBeCloseTo(2.4);
  });
  it("says nothing rather than a meaningless 0.02 s", () => {
    expect(readySeconds(boot, idle)).toBeUndefined();
    expect(readySeconds({ ...boot, ms: 1500 }, idle)).toBe(1.5);
  });
});
