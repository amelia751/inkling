import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canConfirmDelete, fetchFilesImpact } from "./trash-api";

let status = 200;
beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response(status === 200 ? JSON.stringify({ impact: { items: [], files: 1, datasetsLosingItems: [] } }) : JSON.stringify({ detail: "boom" }), { status, headers: { "Content-Type": "application/json" } }));
});
afterEach(() => vi.unstubAllGlobals());

describe("todo18: delete is blocked when the impact preview fails", () => {
  it("throws on a server error instead of resolving null (which deleted blind)", async () => {
    status = 500;
    await expect(fetchFilesImpact("p", ["n1"])).rejects.toThrow();
  });
  it("still resolves null when the api lacks the endpoint, and the impact when it works", async () => {
    status = 404;
    expect(await fetchFilesImpact("p", ["n1"])).toBeNull();
    status = 200;
    expect((await fetchFilesImpact("p", ["n1"]))?.files).toBe(1);
  });
  it("Confirm waits for a loaded preview", () => {
    expect(canConfirmDelete(null, null)).toBe(false);
    expect(canConfirmDelete(null, "500")).toBe(false);
    expect(canConfirmDelete({ items: [], files: 0, datasetsLosingItems: [] }, null)).toBe(true);
  });
});

describe("todo18: Restore all is one request", () => {
  it("posts every batch in one call", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ restored: [], relocatedToRoot: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const { restoreBatches } = await import("./trash-api");
    await restoreBatches("p", ["b1", "b2", "b3"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/trash/b1/restore");
    expect(calls[0]!.body).toEqual({ batchIds: ["b2", "b3"] });
  });
});

describe("todo18: restore into a taken name", () => {
  it("rejects with the Sources conflict error and retries with resolutions", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      return bodies.length === 1
        ? new Response(JSON.stringify({ detail: { message: "a.png exists", conflicts: [{ nodeId: "n1", name: "a.png", kind: "name" }] } }), { status: 409, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ restored: [], relocatedToRoot: false }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const { restoreBatch } = await import("./trash-api");
    const { FsConflictApiError } = await import("./files/api");
    const e = await restoreBatch("p", "b1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FsConflictApiError);
    expect((e as InstanceType<typeof FsConflictApiError>).conflicts[0]!.name).toBe("a.png");
    await restoreBatch("p", "b1", { n1: "keep_both" } as never);
    expect(bodies[1]).toEqual({ resolutions: { n1: "keep_both" } });
  });
});
