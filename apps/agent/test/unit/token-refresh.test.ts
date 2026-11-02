import { describe, expect, it, vi } from "vitest";
import { KernelClient, KernelError } from "../../src/tools/kernel.ts";

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("todo18 D delegated token refresh inside a run", () => {
  it("a 401 asks for a fresh token and retries once with it", async () => {
    let token = "old";
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const auth = (init!.headers as Record<string, string>).Authorization!;
      seen.push(auth);
      return auth === "Bearer new" ? res(200, { ok: true }) : res(401, { detail: "expired" });
    }) as unknown as typeof fetch;
    const refresh = vi.fn(async () => ((token = "new"), true));
    const k = new KernelClient({ baseUrl: "http://k", workspaceId: "w", token: () => token, refresh, fetchImpl });
    await expect(k.get("/x")).resolves.toEqual({ ok: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["Bearer old", "Bearer new"]);
  });

  it("no fresh token: the 401 stands, no loop", async () => {
    const fetchImpl = vi.fn(async () => res(401, { detail: "expired" })) as unknown as typeof fetch;
    const refresh = vi.fn(async () => false);
    const k = new KernelClient({ baseUrl: "http://k", workspaceId: "w", token: () => "old", refresh, fetchImpl });
    await expect(k.get("/x")).rejects.toBeInstanceOf(KernelError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
