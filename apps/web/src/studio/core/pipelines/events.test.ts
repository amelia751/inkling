import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { emitProjectEvent, FORWARDED, onProjectEvent } from "@/studio/lib/use-project-events";
import { PIPELINE_EVENTS, type PipelineRun, type RunsPage } from "./contract";
import { pipelineKeys } from "./api";
import { handlePipelineEvent } from "./events";
import { detail, summary } from "./fixtures";

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("pipeline events on the project stream", () => {
  it("are all forwarded by the shared stream (P§15 list)", () => {
    for (const t of PIPELINE_EVENTS) expect(FORWARDED).toContain(t);
  });

  it("patch the cached list and detail, then invalidate both", () => {
    const qc = client();
    qc.setQueryData<RunsPage>(pipelineKeys.runs("p1"), { runs: [summary({ state: "awaiting_review" }), summary({ run_id: "run_2", state: "awaiting_review" })] });
    qc.setQueryData<PipelineRun>(pipelineKeys.run("run_1"), detail());
    const spy = vi.spyOn(qc, "invalidateQueries");
    handlePipelineEvent(qc, "p1", "review.approved", { project_id: "p1", run_id: "run_1", review_id: "rv_1" });
    expect(qc.getQueryData<RunsPage>(pipelineKeys.runs("p1"))!.runs.map((r) => r.state)).toEqual(["publishing", "awaiting_review"]);
    expect(qc.getQueryData<PipelineRun>(pipelineKeys.run("run_1"))!.state).toBe("publishing");
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toEqual([pipelineKeys.runs("p1"), pipelineKeys.run("run_1")]);
  });

  it("ignore another project's events and Studio reviews without a run", () => {
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    handlePipelineEvent(qc, "p1", "pipeline.run.started", { project_id: "p2", run_id: "run_9" });
    handlePipelineEvent(qc, "p1", "review.requested", { project_id: "p1", review_id: "rv_9" });
    expect(spy).not.toHaveBeenCalled();
    handlePipelineEvent(qc, "p1", "pipeline.output.staged", {});
    expect(spy).toHaveBeenCalledWith({ queryKey: pipelineKeys.runs("p1") });
  });

  it("reach subscribers through onProjectEvent", () => {
    const seen: unknown[] = [];
    const off = onProjectEvent("pipeline.step.completed", (d, pid) => seen.push([pid, d]));
    emitProjectEvent("pipeline.step.completed", { run_id: "run_1", step_id: "inspect" }, "p1");
    off();
    emitProjectEvent("pipeline.step.completed", { run_id: "run_1" }, "p1");
    expect(seen).toEqual([["p1", { run_id: "run_1", step_id: "inspect" }]]);
  });
});
