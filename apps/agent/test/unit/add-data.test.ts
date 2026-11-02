import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@studio/agent-protocol";
import { safeImport } from "../../src/tools/drops.ts";
import { harness } from "./harness.ts";

/**
 * todo16 D10: the assistant adds data without seeing it. import_from_url and copy_into_project
 * call the kernel's import routes and show the model file facts only; request_upload is a card.
 */

const KTOKEN = "kernel-session-token-0123456789";
const IMPORTED = {
  importId: "imp-1",
  state: "inspecting",
  files: [{ name: "chest.png", size: 1234, state: "uploaded" }, { name: "https://evil/x?sig=abc", size: 1, state: "uploaded" }],
  totals: { files: 2, bytes: 1235, committed: 2 },
  data: "QUJD".repeat(100),
};

function fakeKernel() {
  const seen: { path: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const send = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${KTOKEN}`) return send(401, { detail: "invalid token" });
    if (init?.method === "POST" && url.pathname === "/api/v1/projects/demo/imports/url") return send(202, { importId: "imp-2", state: "fetching", jobId: "job-1" });
    if (init?.method === "POST" && url.pathname === "/api/v1/projects/demo/imports/copy") return send(201, IMPORTED);
    return send(404, { detail: "no route" });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("add data from chat", () => {
  it("keeps only file facts", () => {
    const r = safeImport(IMPORTED);
    expect(r).toEqual({ importId: "imp-1", state: "inspecting", files: [{ name: "chest.png", size: 1234, state: "uploaded" }, { name: "file", size: 1, state: "uploaded" }], committed: 2 });
    expect(JSON.stringify(r)).not.toMatch(/QUJD|https?:/);
  });

  it("imports from a link and copies from a sample through the kernel (scripted model)", async () => {
    const api = fakeKernel();
    const fixture = {
      scripts: [
        {
          turns: [
            { toolCalls: [{ name: "import_from_url", arguments: { url: "https://example.com/chest.png" } }] },
            { toolCalls: [{ name: "copy_into_project", arguments: { sampleId: "ws-a" } }] },
            { text: "Added chest.png." },
          ],
        },
      ],
    };
    h = await harness(fixture, {}, [], { fetchImpl: api.fetchImpl });
    const s = await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: [], kernelToken: KTOKEN });
    expect(s.status).toBe(201);
    const m = await h.json("POST", `/v1/sessions/${s.body.sessionId}/messages`, { text: "add the chest X-rays from this link", kernelToken: KTOKEN });
    expect(m.status).toBe(202);
    const asked: string[] = [];
    const events: AgentEvent[] = await h.drive(m.body.runId, async (e) => {
      if (e.type !== "approval") return;
      // Nothing is sent before the person answers the rights card.
      expect(api.seen.filter((x) => x.path.includes("/imports/"))).toHaveLength(asked.length);
      asked.push((e as { summary: string }).summary);
      expect((await h!.json("POST", `/v1/approvals/${e.approvalId}`, { decision: "approve" })).status).toBe(200);
    });
    expect(asked).toHaveLength(2);
    expect(asked.every((x) => x.startsWith("Do you have the rights to add this data?"))).toBe(true);
    expect(asked[0]).toContain("https://example.com");
    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(2);
    expect(results.every((e) => (e as { ok: boolean }).ok)).toBe(true);
    const posts = api.seen.filter((x) => x.path.includes("/imports/"));
    expect(posts.map((x) => x.path)).toEqual(["/api/v1/projects/demo/imports/url", "/api/v1/projects/demo/imports/copy"]);
    expect(posts[0]!.body).toEqual({ url: "https://example.com/chest.png", attested: true });
    expect(posts[1]!.body).toEqual({ sampleId: "ws-a", attested: true });
    expect(JSON.stringify(results)).not.toMatch(/QUJDQUJD/);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
  });

  it("sends nothing when the person declines the rights card (scripted model)", async () => {
    const api = fakeKernel();
    const fixture = { scripts: [{ turns: [{ toolCalls: [{ name: "import_from_url", arguments: { url: "https://example.com/chest.png" } }] }, { text: "Okay." }] }] };
    h = await harness(fixture, {}, [], { fetchImpl: api.fetchImpl });
    const s = await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: [], kernelToken: KTOKEN });
    const m = await h.json("POST", `/v1/sessions/${s.body.sessionId}/messages`, { text: "add this link", kernelToken: KTOKEN });
    await h.drive(m.body.runId, async (e) => {
      if (e.type === "approval") await h!.json("POST", `/v1/approvals/${e.approvalId}`, { decision: "reject" });
    });
    expect(api.seen.filter((x) => x.path.includes("/imports/"))).toHaveLength(0);
  });
});
