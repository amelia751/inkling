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
