import { describe, expect, it } from "vitest";
import { ITEM_STATES, RUN_STATES } from "./contract";
import { detail, ITEMS, summary } from "./fixtures";
import { applyEvent, canApprove, duration, ITEM_LABEL, ITEM_THEME, isLive, reportRows, RUN_LABEL, RUN_THEME, runCounts, shortDigest, stepName, triggerLabel } from "./model";

describe("pipeline run labels", () => {
  it("names every run and item state in plain words", () => {
    for (const s of RUN_STATES) expect(RUN_LABEL[s] && RUN_THEME[s]).toBeTruthy();
    for (const s of ITEM_STATES) expect(ITEM_LABEL[s] && ITEM_THEME[s]).toBeTruthy();
    expect(RUN_LABEL.awaiting_review).toBe("Needs review");
  });
  it("treats only self-moving states as live (a run waiting for a person isn't polled)", () => {
    expect(RUN_STATES.filter(isLive)).toEqual(["queued", "running", "publishing"]);
  });
  it("labels triggers, steps and digests", () => {
    expect(triggerLabel(summary())).toBe("Upload");
    expect(triggerLabel(summary({ trigger: null }))).toBe("Run");
    expect(stepName({ step_id: "derive_thumbs", state: "pending" })).toBe("Derive thumbs");
    expect(shortDigest("sha256:abcdef0123456789")).toBe("abcdef0123");
  });
});

describe("runCounts", () => {
  it("adds up item_counts", () => {
    expect(runCounts(summary())).toEqual({ total: 10, ok: 8, quarantined: 1, rejected: 1, pending: 0 });
  });
  it("prefers the server's total and falls back to the items", () => {
    expect(runCounts(summary({ item_total: 12 })).total).toBe(12);
    expect(runCounts({ ...detail(), item_counts: undefined })).toEqual({ total: 10, ok: 8, quarantined: 1, rejected: 1, pending: 0 });
  });
});

describe("reportRows", () => {
  it("puts quarantined, then rejected files first, then by path", () => {
    const rows = reportRows(ITEMS);
    expect(rows.map((r) => r.state).slice(0, 3)).toEqual(["quarantined", "rejected", "proposed"]);
    expect(rows.length).toBe(10);
    expect(rows[2].rel_path).toBe("study/echo_01.mp4");
  });
  it("filters problems and the rest", () => {
    expect(reportRows(ITEMS, "problems").map((r) => r.item_id)).toEqual(["it_9", "it_10"]);
    expect(reportRows(ITEMS, "ok")).toHaveLength(8);
  });
});

describe("canApprove", () => {
  it("needs awaiting_review, a candidate digest and the server's say-so", () => {
    expect(canApprove(detail())).toBe(true);
    expect(canApprove(detail({ state: "publishing" }))).toBe(false);
    expect(canApprove(detail({ review: { review_id: "rv_1", status: "OPEN", can_approve: false } }))).toBe(false);
    expect(canApprove(detail({ review: null }))).toBe(false);
    expect(canApprove(detail({ candidate: null }))).toBe(false);
    expect(canApprove(undefined)).toBe(false);
  });
});

describe("duration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(duration(null)).toBe("—");
    expect(duration("2026-11-01T10:00:00Z", "2026-11-01T10:00:04Z")).toBe("4s");
    expect(duration("2026-11-01T10:00:00Z", "2026-11-01T10:02:05Z")).toBe("2m 05s");
    expect(duration("2026-11-01T10:00:00Z", "2026-11-01T11:12:00Z")).toBe("1h 12m");
    expect(duration("2026-11-01T10:00:00Z", null, Date.parse("2026-11-01T10:00:30Z"))).toBe("30s");
  });
});

describe("applyEvent", () => {
  it("moves a run forward on run and review events", () => {
    const r = summary({ state: "queued" });
    expect(applyEvent(r, "pipeline.run.started", { run_id: "run_1" }).state).toBe("running");
    expect(applyEvent(summary(), "review.requested", { run_id: "run_1" }).state).toBe("awaiting_review");
    expect(applyEvent(summary({ state: "awaiting_review" }), "review.approved", { run_id: "run_1" }).state).toBe("publishing");
    expect(applyEvent(summary({ state: "publishing" }), "pipeline.run.completed", { run_id: "run_1", state: "published" }).state).toBe("published");
    expect(applyEvent(summary(), "pipeline.run.failed", { run_id: "run_1", error_class: "timeout" }).state).toBe("failed");
  });
  it("never moves a run backwards or out of a finished state (replays, out-of-order delivery)", () => {
    const done = summary({ state: "published" });
    expect(applyEvent(done, "pipeline.run.started", { run_id: "run_1" })).toBe(done);
    expect(applyEvent(done, "pipeline.run.failed", { run_id: "run_1" })).toBe(done);
    const waiting = summary({ state: "awaiting_review" });
    expect(applyEvent(waiting, "pipeline.run.started", { run_id: "run_1", state: "running" })).toBe(waiting);
  });
  it("ignores other runs and events without a run id", () => {
    const r = summary();
    expect(applyEvent(r, "pipeline.run.failed", { run_id: "run_2" })).toBe(r);
    expect(applyEvent(r, "review.approved", {})).toBe(r);
  });
  it("patches the step an event names", () => {
    const r = detail({ state: "running", steps: [{ step_id: "inspect", state: "succeeded" }, { step_id: "validate", state: "pending" }] });
    const started = applyEvent(r, "pipeline.step.started", { run_id: "run_1", step_id: "validate" });
    expect(started.steps.map((s) => s.state)).toEqual(["succeeded", "running"]);
    expect(started.steps[0]).toBe(r.steps[0]);
    const failed = applyEvent(started, "pipeline.step.failed", { run_id: "run_1", step_id: "validate", attempt: 2 });
    expect(failed.steps[1]).toMatchObject({ state: "failed", attempts: 2 });
    expect(applyEvent(failed, "pipeline.step.failed", { run_id: "run_1", step_id: "validate" })).toBe(failed);
  });
});
