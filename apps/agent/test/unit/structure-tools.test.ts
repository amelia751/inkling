import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelClient } from "../../src/tools/kernel.ts";
import { decide, type Budgets, type PolicyState } from "../../src/tools/policy.ts";
import { createProjectTools } from "../../src/tools/project.ts";
import { harness } from "./harness.ts";

/**
 * todo13 D8 (Milestone 2 item 5): `propose_structure` writes the dataset's structure on the
 * agent's own branch through `PUT /api/v1/datasets/{id}/structure` with the session's kernel
 * token, and gives the model the diff against the person's draft. Scripted model only.
 */

const KTOKEN = "kernel-session-token-0123456789";
const STRUCTURE = {
  schemaVersion: 1,
  collections: [{ id: "col-xray", name: "Chest X-rays", kind: "image", formats: ["PNG"], fields: [{ id: "fact:width", name: "Width", type: "integer", unit: "px", required: true, suggested: true }], suggested: true }],
  relationships: [],
  annotations: [{ id: "ann-finding", collectionId: "col-xray", geometry: "class", labels: [{ id: "normal", name: "Normal" }, { id: "pneumonia", name: "Pneumonia" }], suggested: true }],
};

function fakeKernel(accepted = false) {
  const seen: { method: string; path: string; auth: string | null; run: string | null; body?: any }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? "GET", path: url.pathname, auth: h.get("authorization"), run: h.get("x-agent-run"), body });
    const send = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (h.get("authorization") !== `Bearer ${KTOKEN}`) return send(401, { detail: "invalid token" });
    if (init?.method === "PUT" && url.pathname === "/api/v1/datasets/ds-1/structure") {
      if (body.structure.annotations.some((a: any) => a.collectionId === "col-nope")) return send(422, { ok: false, errors: [{ path: "/annotations/0/collectionId", message: "no collection col-nope" }] });
      return send(200, {
        datasetId: "ds-1",
        branch: "work/agent-run_s1/ds-1",
        structure: body.structure,
        hash: "sha256:abc",
        diff: [
          { op: "add", path: "annotations/ann-finding" },
          { op: "add", path: "collections/col-xray" },
        ],
        ...(accepted ? { accepted: true } : {}),
      });
    }
    return send(404, { detail: `no route ${url.pathname}` });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe("propose_structure", () => {
  it("PUTs the structure with the session token and returns the branch and diff, nothing else", async () => {
    const api = fakeKernel();
    const k = new KernelClient({ baseUrl: "http://kernel.test", workspaceId: "prj-1", token: () => KTOKEN, headers: () => ({ "X-Agent-Run": "run_s1" }), fetchImpl: api.fetchImpl });
    const tool = createProjectTools(k).find((t) => t.name === "propose_structure")!;
    const r = await tool.execute("call_1", { datasetId: "ds-1", structure: STRUCTURE, reason: "Two labels from the request" } as never, undefined, undefined, undefined as never);
    const put = api.seen.at(-1)!;
    expect(put).toMatchObject({ method: "PUT", path: "/api/v1/datasets/ds-1/structure", auth: `Bearer ${KTOKEN}`, run: "run_s1" });
    expect(put.body).toEqual({ structure: STRUCTURE });
    const value = JSON.parse((r.content[0] as { text: string }).text);
    expect(value).toEqual({ datasetId: "ds-1", branch: "work/agent-run_s1/ds-1", hash: "sha256:abc", diff: [{ op: "add", path: "annotations/ann-finding" }, { op: "add", path: "collections/col-xray" }], accepted: false });
    expect((r.details as { summary: string }).summary).toBe("Structure proposed · 2 changes to accept");
  });

  it("reports the kernel's validation errors with their paths", async () => {
    const api = fakeKernel();
    const k = new KernelClient({ baseUrl: "http://kernel.test", workspaceId: "prj-1", token: () => KTOKEN, fetchImpl: api.fetchImpl });
    const tool = createProjectTools(k).find((t) => t.name === "propose_structure")!;
    const bad = { ...STRUCTURE, annotations: [{ ...STRUCTURE.annotations[0], collectionId: "col-nope" }] };
    await expect(tool.execute("c", { datasetId: "ds-1", structure: bad, reason: "x" } as never, undefined, undefined, undefined as never)).rejects.toThrow(/422|collection/);
  });

  it("is allowed by the policy: it writes only the agent's own branch", () => {
    const s = { toolCalls: 0, startedAt: Date.now(), spendUsd: 0, userText: "draft the structure" } as unknown as PolicyState;
    const b = { maxToolCalls: 10, maxRunSeconds: 60, maxSpendUsd: 1 } as unknown as Budgets;
    expect(decide({ toolName: "propose_structure", input: {} }, s, b).kind).toBe("allow");
  });
});

// ---- Through a session on the scripted model ---------------------------------------------------

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  vi.unstubAllGlobals();
});

describe("propose_structure in a run (scripted model)", () => {
  it("the model's call reaches the kernel and its result carries ids and the diff, no names or bytes", async () => {
    const api = fakeKernel(true);
    vi.stubGlobal("fetch", api.fetchImpl);
    const fixture = {
      scripts: [
        {
          when: "labels",
          turns: [{ toolCalls: [{ name: "propose_structure", arguments: { datasetId: "ds-1", structure: STRUCTURE, reason: "Normal and pneumonia, from your message" } }] }, { text: "I drafted the structure: one collection, two labels." }],
        },
      ],
    };
    h = await harness(fixture);
    const s = await h.json("POST", "/v1/sessions", { projectId: "prj-1", profile: "assistant", clientTools: [], kernelToken: KTOKEN });
    expect(s.status).toBe(201);
    const r = await h.json("POST", `/v1/sessions/${s.body.sessionId}/messages`, { text: "Use the labels normal and pneumonia" });
    expect(r.status).toBe(202);
    const events = await h.drive(r.body.runId);
    expect(events.some((e) => e.type === "tool-result" && (e as any).ok)).toBe(true);
    const put = api.seen.find((x) => x.method === "PUT")!;
    expect(put.path).toBe("/api/v1/datasets/ds-1/structure");
    expect(put.run).toMatch(/^run_/);
    const msgs = (await h.sessions.get(s.body.sessionId)).piSession.messages as any[];
    const result = msgs.find((m) => m.role === "toolResult" && m.toolName === "propose_structure");
    const text = (result.content as any[]).map((c) => c.text ?? "").join("");
    expect(JSON.parse(text)).toMatchObject({ datasetId: "ds-1", accepted: true, diff: [{ op: "add" }, { op: "add" }] });
    expect(text).not.toMatch(/base64|data:|https?:\/\//);
  });
});
