import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@studio/agent-protocol";
import { loadScript } from "../../src/agent/models.ts";
import { ns } from "../../src/naming.ts";
import { batchSummary } from "../../src/tools/kernel.ts";
import { ENV_TOOLS, harness } from "./harness.ts";

/**
 * todo25 W4: "Segment the lungs on these" is one batch, in one go: list the capability, one
 * create_job over the Studio's 12 items with the `lungs` recipe (no prompts), then a status
 * check that comes back in plain words. Scripted model, fake kernel: no network, no spend.
 */

const KTOKEN = "kernel-session-token-0123456789";
const SEG = ns("segmentation");
const FIXTURE = loadScript(fileURLToPath(new URL("./fixtures/segment-lungs.json", import.meta.url)));
const spec = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {} } });

const jobView = (jobId: string, state: string) => ({
  schema: "boundary.job-summary/v1",
  jobId,
  kind: "capability",
  state,
  progress: state === "succeeded" ? 1 : 0,
  counts: { total: "<20", succeeded: state === "succeeded" ? "<20" : 0, failed: 0 },
  errorClasses: [],
  createdAt: "2026-11-04T00:00:00+00:00",
  updatedAt: null,
});

/** Just enough of apps/api's gateway and boundary job view. */
async function fakeKernel() {
  const calls: { path: string; idem?: string; body: any }[] = [];
  const read = (req: IncomingMessage) => new Promise<string>((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
  const server: Server = createServer(async (req, res) => {
    const raw = await read(req);
    const path = req.url ?? "";
    calls.push({ path, idem: req.headers["idempotency-key"] as string, body: raw ? JSON.parse(raw) : undefined });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${KTOKEN}`) return send(401, { detail: "invalid token" });
    if (path === "/api/v1/commands") {
      const inputs = (JSON.parse(raw) as { inputs: unknown[] }).inputs;
      return send(202, { jobs: inputs.map((_, i) => ({ ...jobView(`job_${i + 1}`, "queued"), annotationIds: [] })), estimateUsd: inputs.length * 0.0025 });
    }
    const m = path.match(/^\/api\/v1\/boundary\/jobs\/(job_\d+)$/);
    if (m) return send(200, { job: jobView(m[1]!, "succeeded"), result: { annotationIds: [`${m[1]}_right`, `${m[1]}_left`] } });
    send(404, { detail: `no route ${path}` });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let h: Awaited<ReturnType<typeof harness>> | undefined;
let k: Awaited<ReturnType<typeof fakeKernel>> | undefined;
afterEach(async () => {
  await h?.cleanup();
  await k?.close();
  h = k = undefined;
});

describe("segment the lungs on these (todo25 W4)", () => {
  it("list → one create_job over 12 items with the lungs recipe → status → plain-words summary", async () => {
    k = await fakeKernel();
    h = await harness(FIXTURE, { API_URL: k.url });
    const s = await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: [...ENV_TOOLS, spec("list_capabilities")], kernelToken: KTOKEN });
    expect(s.status).toBe(201);
    const r = await h.json("POST", `/v1/sessions/${s.body.sessionId}/messages`, { text: "Segment the lungs on these" });
    expect(r.status).toBe(202);
    const runId = r.body.runId as string;
    const approvals: string[] = [];
    const events = await h.drive(runId, async (e: AgentEvent) => {
      if (e.type === "client-tool" && e.name === "list_capabilities")
        await h!.json("POST", `/v1/runs/${runId}/client-tools/${e.callId}`, {
          ok: true,
          output: { capabilities: [{ id: "image.segment", plugin: SEG, provider: "meta.sam", model: "sam-3.1", hosted: true }] },
        });
      if (e.type === "approval") {
        approvals.push(e.summary);
        await h!.json("POST", `/v1/approvals/${e.approvalId}`, { decision: "approve" });
      }
    });

    // One batch, not a loop: a single gateway call with 12 recipe inputs and no prompts.
    const cmds = k.calls.filter((c) => c.path === "/api/v1/commands");
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.idem).toMatch(/^agent:/);
    expect(cmds[0]!.body.capability).toBe("image.segment");
    expect(cmds[0]!.body.inputs).toHaveLength(12);
    for (const i of cmds[0]!.body.inputs) {
      expect(i.label).toBe("lungs");
      expect(i.prompts).toBeUndefined();
    }
    expect(approvals).toEqual([expect.stringMatching(/image\.segment on 12 inputs/)]);
    // The consent line comes before the call.
    const text = events.filter((e) => e.type === "text").map((e: any) => e.delta).join("");
    expect(text).toMatch(/12 images will be sent to Meta.s SAM 3\.1, about \$0\.03/);

    // Status for the whole batch, in plain words, pointing to the Masks panel.
    expect(k.calls.filter((c) => c.path.startsWith("/api/v1/boundary/jobs/"))).toHaveLength(12);
    const results = events.filter((e): e is Extract<AgentEvent, { type: "tool-result" }> => e.type === "tool-result");
    expect(results.every((e) => e.ok)).toBe(true);
    expect(results.at(-1)!.summary).toBe("12 images: 12 done, 0 failed; 24 masks made, waiting for review in the Masks panel. Estimated spend $0.03.");
    expect(text).toMatch(/Masks panel/);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
  });

  it("batchSummary says what is still running, what failed and nothing it can't know", () => {
    const j = (jobId: string, state: string, annotationIds: string[] = [], errorClasses: unknown[] = []) => ({ jobId, kind: "capability", state, progress: 0, counts: {}, errorClasses, annotationIds });
    const s = batchSummary([j("a", "succeeded", ["m1", "m2"]), j("b", "running"), j("c", "failed", [], [{ errorClass: "ProviderTimeout", count: 1 }])], { capability: "image.segment" });
    expect(s.summary).toBe("3 images: 1 done, 1 failed, 1 still running; 2 masks so far, waiting for review in the Masks panel.");
    expect(s).toMatchObject({ finished: false, errorClasses: ["ProviderTimeout"], review: { panel: "Masks", annotationIds: ["m1", "m2"] } });
    expect(batchSummary([j("a", "succeeded", ["x"])], { capability: "text.classify", estimateUsd: 0.004 }).summary).toBe("1 input: 1 done, 0 failed; 1 annotation made, waiting for review. Estimated spend $0.0040.");
  });
});
