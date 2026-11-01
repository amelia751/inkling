import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/studio/lib/projects-api";
import { pipelineApi } from "./api";

function mockFetch(status = 200, body: unknown = {}) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("pipeline gateway client (P§15 routes)", () => {
  it("lists a project's runs, with state filters and a cursor", async () => {
    const f = mockFetch(200, { runs: [] });
    await pipelineApi.runs("p 1");
    await pipelineApi.runs("p1", { state: ["awaiting_review", "running"], cursor: "c2" });
    expect(f.mock.calls[0][0]).toBe("/api/v1/projects/p%201/pipeline-runs");
    expect(f.mock.calls[1][0]).toBe("/api/v1/projects/p1/pipeline-runs?state=awaiting_review%2Crunning&cursor=c2");
  });

  it("reads one run", async () => {
    const f = mockFetch(200, { run_id: "run_1" });
    await pipelineApi.run("run_1");
    expect(f.mock.calls[0][0]).toBe("/api/v1/pipeline-runs/run_1");
  });

  it("approves bound to the candidate digest, with an idempotency key", async () => {
    const f = mockFetch(200, { approval_id: "ap_1", state: "publishing" });
    const res = await pipelineApi.approve("run_1", "sha256:feed");
    const init = f.mock.calls[0][1]!;
    expect(f.mock.calls[0][0]).toBe("/api/v1/pipeline-runs/run_1/approve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ candidate_digest: "sha256:feed" });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("approve:run_1:sha256:feed");
    expect(res.approval_id).toBe("ap_1");
  });

  it("surfaces a stale digest as a 409 ApiError", async () => {
    mockFetch(409, { detail: "candidate changed" });
    await expect(pipelineApi.approve("run_1", "sha256:old")).rejects.toMatchObject({ status: 409, message: "candidate changed" });
    await expect(pipelineApi.approve("run_1", "sha256:old")).rejects.toBeInstanceOf(ApiError);
  });
});
