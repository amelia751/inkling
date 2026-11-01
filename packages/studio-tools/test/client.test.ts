import { describe, expect, it } from "vitest";
import { StudioApiError, StudioClient } from "../src/client.ts";

interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body?: unknown;
}

function fake(respond: (s: Seen) => [number, unknown]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = { method: init?.method ?? "GET", url: String(input), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    const [status, value] = respond(s);
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe("StudioClient", () => {
  it("posts a boot with the token and extra headers", async () => {
    const f = fake(() => [202, { bootId: "b1", taskIds: ["t1"], state: "ready", preset: "preset:image-2d", ms: 120 }]);
    const c = new StudioClient({ baseUrl: "http://api.test", token: () => "tok", headers: () => ({ "X-Workspace-Id": "prj-1", "X-Agent-Run": "run-1" }), fetch: f.fetchImpl });
    const r = await c.boot("prj-1", { bootId: "b1", preset: "preset:image-2d", name: "CXR" });
    expect(r.taskIds).toEqual(["t1"]);
    const s = f.seen[0]!;
    expect(s.method).toBe("POST");
    expect(s.url).toBe("http://api.test/api/v1/projects/prj-1/boots");
    expect(s.headers.get("authorization")).toBe("Bearer tok");
    expect(s.headers.get("x-workspace-id")).toBe("prj-1");
    expect(s.headers.get("x-agent-run")).toBe("run-1");
    expect(s.body).toEqual({ bootId: "b1", preset: "preset:image-2d", name: "CXR" });
  });

  it("routes environments, boots and tasks", async () => {
    const f = fake((s) => [200, s.url.includes("/environments/") ? { revision: 3, environment: {} } : { id: "t1", state: "draft" }]);
    const c = new StudioClient({ baseUrl: "http://api.test/", fetch: f.fetchImpl });
    await c.getEnvironment("t 1");
    await c.patchEnvironment("t1", [{ op: "replace", path: "/title", value: "X" }], 3);
    await c.getBoot("b1");
    await c.getTask("t1");
    expect(f.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "GET /api/environments/t%201",
      "PATCH /api/environments/t1",
      "GET /api/v1/boots/b1",
      "GET /api/v1/tasks/t1",
    ]);
    expect(f.seen[1]!.body).toEqual({ patch: [{ op: "replace", path: "/title", value: "X" }], revision: 3 });
    expect(f.seen[0]!.headers.get("authorization")).toBeNull();
  });

  it("types errors: 422 errors[], 409 current, FastAPI detail, 403", async () => {
    const answers: [number, unknown][] = [
      [422, { ok: false, errors: [{ path: "/viewports/0/renderer", code: "reference", message: "unknown renderer" }] }],
      [409, { error: "stale revision", current: 7 }],
      [409, { detail: { error: "stale revision", current: 8 } }],
      [403, { detail: "agents may not publish" }],
      [422, { detail: { ok: false, errors: [{ path: "/modules/x", code: "scope", message: "not installed" }] } }],
    ];
    let i = 0;
    const f = fake(() => answers[i++]!);
    const c = new StudioClient({ baseUrl: "http://api.test", fetch: f.fetchImpl });
    const err = async () => c.patchEnvironment("t1", [], 1).then(() => undefined, (e: StudioApiError) => e);
    const a = await err();
    expect(a).toBeInstanceOf(StudioApiError);
    expect(a!.status).toBe(422);
    expect(a!.errors).toEqual([{ path: "/viewports/0/renderer", code: "reference", message: "unknown renderer" }]);
    expect((await err())!.current).toBe(7);
    expect((await err())!.current).toBe(8);
    const forbidden = await err();
    expect(forbidden!.status).toBe(403);
    expect(forbidden!.message).toBe("agents may not publish");
    expect((await err())!.errors[0]?.code).toBe("scope");
  });

  it("refuses without a token when a token provider is set", async () => {
    const f = fake(() => [200, {}]);
    const c = new StudioClient({ baseUrl: "http://api.test", token: () => undefined, fetch: f.fetchImpl });
    await expect(c.getTask("t1")).rejects.toMatchObject({ status: 401 });
    expect(f.seen).toHaveLength(0);
  });
});
