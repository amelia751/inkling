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

  const RASTER = "studio.image2d.dataKinds.raster";
  const ECG = "studio.timeseries.dataKinds.multichannel-timeseries";

  it("boot_studio takes accepts (kind ids) and a filter: one Studio extending one profile per kind (todo19 D12)", async () => {
    const { h, calls } = setup(ok);
    const r = await h.boot_studio({ accepts: [RASTER, "multichannel-timeseries"], filter: { folders: ["fld-1"], nameContains: "ptb" }, name: "Mixed review" }, { seed: "s" });
    const body = calls[0]!.body;
    expect(body.accepts).toEqual([RASTER, ECG]);
    expect(body.extends).toEqual(["preset:image-2d", "preset:ecg"]);
    expect(body.preset).toBe("preset:image-2d");
    expect(body.filter).toEqual({ folders: ["fld-1"], nameContains: "ptb" });
    expect(r).toMatchObject({ accepts: [RASTER, ECG], profiles: { [RASTER]: "preset:image-2d", [ECG]: "preset:ecg" } });
  });

  it("boot_studio: an explicit preset is the profile for its kind; unknown kinds are refused before the API", async () => {
    const { h, calls } = setup(ok);
    await h.boot_studio({ preset: "preset:generic-image", accepts: [RASTER, ECG] });
    expect(calls[0]!.body.extends).toEqual(["preset:generic-image", "preset:ecg"]);
    const bad = await h.boot_studio({ accepts: ["studio.nope.dataKinds.x"] }).catch((e) => e);
    expect(bad).toBeInstanceOf(StudioToolError);
    expect(bad.toJSON()).toMatchObject({ status: 422, errors: [{ path: "/accepts/0", code: "reference" }] });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("patch_studio edits data.kinds.<kind> and checks the kind and that the renderer consumes it", async () => {
    const { h, calls } = setup((m, p, b) => (m === "PATCH" ? [200, { revision: 3 }] : ok(m, p, b)));
    const r = await h.patch_studio({ taskId: "tsk-1", revision: 2, patch: [{ op: "add", path: `/data/kinds/${ECG}`, value: { renderer: "studio.timeseries.renderers.strip-chart" } }] });
    expect(r.revision).toBe(3);
    const wrongKind = await h.patch_studio({ taskId: "tsk-1", revision: 3, patch: [{ op: "add", path: "/data/kinds/studio.nope.dataKinds.x", value: { renderer: "x" } }] }).catch((e) => e);
    expect(wrongKind.toJSON()).toMatchObject({ status: 422, errors: [{ path: "/0", code: "reference" }] });
    const mismatch = await h.patch_studio({ taskId: "tsk-1", revision: 3, patch: [{ op: "replace", path: `/data/kinds/${ECG}/renderer`, value: "studio.image2d.renderers.canvas-raster" }] }).catch((e) => e);
    expect(mismatch.toJSON()).toMatchObject({ status: 422, errors: [{ path: "/0", code: "renderer-data-mismatch" }] });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("get_studio_state reports the kinds, and the active item's kind and profile", async () => {
    const env = { extends: ["preset:image-2d", "preset:ecg"], accepts: [RASTER, ECG], data: { kinds: { [ECG]: { renderer: "studio.timeseries.renderers.strip-chart", profile: "preset:ecg" } } } };
    const effective = { ...env, data: { kinds: { ...env.data.kinds, [RASTER]: { renderer: "studio.image2d.renderers.cornerstone-stack", profile: "preset:image-2d" } } } };
    const { h } = setup((m, p) => (p.startsWith("/api/environments/") ? [200, { revision: 4, environment: env, effective }] : [200, { id: "tsk-1", state: "draft" }]));
    const s = await h.get_studio_state({ taskId: "tsk-1", itemId: "itm-7", itemKind: ECG });
    expect(s.accepts).toEqual([RASTER, ECG]);
    expect(s.kinds).toEqual({ [RASTER]: { renderer: "studio.image2d.renderers.cornerstone-stack", profile: "preset:image-2d" }, [ECG]: { renderer: "studio.timeseries.renderers.strip-chart", profile: "preset:ecg" } });
    expect(s.activeItem).toEqual({ id: "itm-7", kind: ECG, profile: { renderer: "studio.timeseries.renderers.strip-chart", profile: "preset:ecg" } });
    const unmapped = await h.get_studio_state({ taskId: "tsk-1", itemId: "itm-8", itemKind: "studio.video.dataKinds.video" });
    expect(unmapped.activeItem).toMatchObject({ kind: "studio.video.dataKinds.video", profile: null, note: expect.stringMatching(/file view/) });
  });

  it("offer_studio creates nothing", async () => {
    const { h, calls } = setup(ok);
    const r = await h.offer_studio({ preset: "preset:image-2d", title: "Create X-ray Studio", reason: "Chest X-ray triage" });
    expect(r.offer.preset).toBe("preset:image-2d");
    expect(calls).toHaveLength(0);
  });
});
