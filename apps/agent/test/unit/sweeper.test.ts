import { describe, expect, it } from "vitest";
import { NAMING } from "../../src/naming.ts";
import { type SweepCandidate, planReclaim, planSweep } from "../../src/sandbox/sweeper.ts";

const RES = NAMING.resourcePrefix;

const NOW = Date.parse("2026-10-29T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const sb = (id: string, o: Partial<SweepCandidate> & { session?: string; app?: string; env?: string } = {}): SweepCandidate => ({
  id,
  name: id,
  state: o.state ?? "started",
  labels: { app: o.app ?? `${RES}`, env: o.env ?? "test", session: o.session ?? id },
  createdAt: o.createdAt ?? ago(60),
  lastActivityAt: o.lastActivityAt ?? ago(60),
});

const policy = { env: "test", now: NOW, activeSessions: new Set<string>(), idleStopMin: 30, retentionDays: 7, maxDeletes: 5 };

describe("planSweep", () => {
  it("stops idle started sandboxes, oldest first, and leaves recent ones", () => {
    const plan = planSweep([sb("recent", { lastActivityAt: ago(5) }), sb("old", { lastActivityAt: ago(120) }), sb("older", { lastActivityAt: ago(500) })], policy);
    expect(plan.stop.map((c) => c.id)).toEqual(["older", "old"]);
    expect(plan.delete).toEqual([]);
  });

  it("never touches other apps, other envs, or sessions with an active run", () => {
    const plan = planSweep(
      [sb("foreign", { app: "jetrun" }), sb("prod", { env: "production" }), sb("busy", { session: "busy" })],
      { ...policy, activeSessions: new Set(["busy"]), knownSessions: new Set() },
    );
    expect(plan.stop).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  it("deletes orphans and expired sandboxes, at most maxDeletes per pass", () => {
    const many = Array.from({ length: 8 }, (_, i) => sb(`orphan${i}`, { lastActivityAt: ago(100 + i) }));
    const plan = planSweep([...many, sb("expired", { session: "known", createdAt: ago(8 * 24 * 60), lastActivityAt: ago(8 * 24 * 60) })], { ...policy, knownSessions: new Set(["known"]) });
    expect(plan.delete).toHaveLength(5);
    expect(plan.delete[0]!.sandbox.id).toBe("expired");
    expect(plan.delete[0]!.reason).toBe("retention");
    expect(plan.delete.slice(1).every((d) => d.reason === "orphan")).toBe(true);
  });

  it("doesn't stop what it is deleting", () => {
    const plan = planSweep([sb("o", { lastActivityAt: ago(999) })], { ...policy, knownSessions: new Set() });
    expect(plan.delete.map((d) => d.sandbox.id)).toEqual(["o"]);
    expect(plan.stop).toEqual([]);
  });
});

describe("planReclaim", () => {
  it("stops only started, idle, owned sandboxes, oldest first, capped", () => {
    const list = [
      sb("a", { lastActivityAt: ago(10) }),
      sb("b", { lastActivityAt: ago(50) }),
      sb("stopped", { state: "stopped", lastActivityAt: ago(999) }),
      sb("busy", { lastActivityAt: ago(999) }),
      sb("foreign", { app: "x", lastActivityAt: ago(999) }),
    ];
    expect(planReclaim(list, { env: "test", activeSessions: new Set(["busy"]) }, 1).map((c) => c.id)).toEqual(["b"]);
  });
});
