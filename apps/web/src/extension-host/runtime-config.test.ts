import { afterEach, describe, expect, it, vi } from "vitest";
import { apiUrl, applyRuntimeConfig, loadRuntimeConfig, runtimeConfig } from "./runtime-config";

afterEach(() => {
  vi.unstubAllGlobals();
  applyRuntimeConfig(null);
});

describe("runtime config", () => {
  it("defaults to same-origin paths", () => {
    const c = applyRuntimeConfig(null);
    expect(c).toMatchObject({ apiBase: "/api", agentBase: "/api/agent", kernel: false, flags: [], auth: { mode: "dev" } });
    expect(apiUrl("/v1/commands")).toBe("/api/v1/commands");
  });

  it("merges a config document and ignores mistyped keys", () => {
    applyRuntimeConfig({ apiBase: "https://api.example.test/api/", kernel: true, flags: ["agentPanels", 3], agentBase: 42 });
    expect(runtimeConfig()).toMatchObject({ apiBase: "https://api.example.test/api", agentBase: "/api/agent", kernel: true, flags: ["agentPanels"] });
    expect(apiUrl("/v1/jobs/1")).toBe("https://api.example.test/api/v1/jobs/1");
  });

  it("reads the auth mode and ignores unknown ones", () => {
    expect(applyRuntimeConfig({ auth: { mode: "workos" } }).auth.mode).toBe("workos");
    expect(applyRuntimeConfig({ auth: { mode: "magic" } }).auth.mode).toBe("dev");
    expect(applyRuntimeConfig({ auth: "workos" }).auth.mode).toBe("dev");
  });

  it("falls back to defaults when /config.json is missing or HTML (dev server fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } })));
    expect((await loadRuntimeConfig()).kernel).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ kernel: true })));
    expect((await loadRuntimeConfig()).kernel).toBe(true);
  });
});
