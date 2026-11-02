import { afterEach, describe, expect, it, vi } from "vitest";
import { backToDefaultPrincipal, devPrincipal, installDevPrincipalFetch, personKey, startAsNewPerson, withDevPrincipal } from "./dev-principal";

describe("dev principal (todo14 M0)", () => {
  afterEach(() => backToDefaultPrincipal());

  it("defaults to no principal, so storage keys and URLs are unchanged", () => {
    expect(devPrincipal()).toBeNull();
    expect(personKey("x-ai")).toBe("x-ai");
    expect(withDevPrincipal("/api/v1/projects/p/events")).toBe("/api/v1/projects/p/events");
  });

  it("starts a new person per tab and scopes keys and EventSource URLs to them", () => {
    const p = startAsNewPerson();
    expect(p).toMatch(/^user:dev-[a-z0-9]{4,32}$/);
    expect(devPrincipal()).toBe(p);
    expect(personKey("x-ai")).toBe(`x-ai:${p}`);
    expect(withDevPrincipal("/e?after=1")).toBe(`/e?after=1&devPrincipal=${encodeURIComponent(p!)}`);
    backToDefaultPrincipal();
    expect(devPrincipal()).toBeNull();
  });

  it("adds X-Dev-Principal to api and agent requests only", async () => {
    const seen: { url: string; header: string | null }[] = [];
    const stub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), header: new Headers(init?.headers).get("X-Dev-Principal") });
      return Promise.resolve(new Response("{}"));
    });
    vi.stubGlobal("fetch", stub);
    window.fetch = stub as typeof fetch;
    installDevPrincipalFetch(() => ["/api", "/api/agent"]);
    await fetch("/api/v1/projects");
    const p = startAsNewPerson()!;
    await fetch("/api/v1/projects", { headers: { Accept: "application/json" } });
    await fetch("/api/agent/sessions");
    await fetch("/seed/manifest.json");
    await fetch("https://elsewhere.example/api/v1");
    expect(seen.map((s) => s.header)).toEqual([null, p, p, null, null]);
    vi.unstubAllGlobals();
  });
});
