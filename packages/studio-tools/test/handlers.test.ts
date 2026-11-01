import { describe, expect, it } from "vitest";
import { StudioClient } from "../src/client.ts";
import { StudioToolError, createStudioHandlers, deriveBootId } from "../src/handlers.ts";
import { catalog, intents } from "./fixtures.ts";

function setup(answer: (method: string, path: string, body: any) => [number, unknown]) {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    const [status, value] = answer(init?.method ?? "GET", path, body);
    return new Response(JSON.stringify(value), { status });
  }) as typeof fetch;
  const h = createStudioHandlers({ client: new StudioClient({ baseUrl: "http://api.test", fetch: fetchImpl }), catalog, intents, projectId: "prj-1" });
  return { h, calls };
}

const ok = (method: string, path: string, body: any): [number, unknown] =>
  method === "POST" ? [202, { bootId: body.bootId, taskIds: ["tsk-1"], state: "ready", preset: body.preset, ms: 90 }] : path.startsWith("/api/environments/") ? [200, { revision: 2, environment: { extends: "preset:image-2d" }, effective: { huge: true } }] : [200, { id: "tsk-1", state: "draft" }];

describe("Studio handlers", () => {
  it("boots from the intent table with a stable bootId per seed", async () => {
    const { h, calls } = setup(ok);
    const a = await h.boot_studio({ intent: "Create a chest X-ray Studio with five classification labels" }, { seed: "run-1/call-1" });
    const b = await h.boot_studio({ intent: "Create a chest X-ray Studio with five classification labels" }, { seed: "run-1/call-1" });
    expect(a.preset).toBe("preset:image-2d");
    expect(a.presetFrom).toBe("intent");
    expect(a.taskId).toBe("tsk-1");
    expect(a.revision).toBe(2);
    expect(a.bootId).toBe(b.bootId);
    expect(a.bootId).toBe(await deriveBootId("prj-1\nrun-1/call-1"));
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/projects/prj-1/boots", body: { bootId: a.bootId, preset: "preset:image-2d" } });
  });

  it("rejects unknown presets before calling the API", async () => {
    const { h, calls } = setup(ok);
    await expect(h.boot_studio({ preset: "preset:nope" })).rejects.toBeInstanceOf(StudioToolError);
    await expect(h.boot_studio({ intent: "hello" })).rejects.toThrow(/No preset matches/);
    expect(calls).toHaveLength(0);
  });

  it("reports 422 errors with paths and 409 with the current revision", async () => {
    const { h } = setup((m) => (m === "PATCH" ? [409, { error: "stale", current: 5 }] : [422, { ok: false, errors: [{ path: "/tools/0", code: "reference", message: "unknown tool" }] }]));
    const stale = await h.patch_studio({ taskId: "t", patch: [{ op: "add", path: "/labels/-", value: {} }], revision: 1 }).catch((e) => e);
    expect(stale).toBeInstanceOf(StudioToolError);
    expect(stale.toJSON()).toMatchObject({ status: 409, current: 5 });
    const bad = await h.boot_studio({ preset: "preset:ecg" }).catch((e) => e);
    expect(bad.toJSON()).toMatchObject({ status: 422, errors: [{ path: "/tools/0", code: "reference" }] });
  });

  it("get_studio_state leaves out the resolved environment", async () => {
    const { h } = setup(ok);
    const s = await h.get_studio_state({ taskId: "tsk-1" });
    expect(s).toEqual({ taskId: "tsk-1", revision: 2, state: "draft", environment: { extends: "preset:image-2d" } });
  });

  it("offer_studio creates nothing", async () => {
    const { h, calls } = setup(ok);
    const r = await h.offer_studio({ preset: "preset:image-2d", title: "Create X-ray Studio", reason: "Chest X-ray triage" });
    expect(r.offer.preset).toBe("preset:image-2d");
    expect(calls).toHaveLength(0);
  });
});
