import { beforeEach, describe, expect, it, vi } from "vitest";

describe("todo15 D5 Home's queued message", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
  });

  it("survives a reload (sessionStorage) and is sent once", async () => {
    const first = await import("./pending-ask");
    first.usePendingAsks.getState().queue("p1", "Classify these", { dropId: "d1", messageId: "m1" });
    vi.resetModules();
    const reloaded = await import("./pending-ask");
    expect(reloaded.usePendingAsks.getState().asks.p1).toEqual({ text: "Classify these", drop: { dropId: "d1", messageId: "m1" } });
    expect(reloaded.usePendingAsks.getState().take("p1")?.text).toBe("Classify these");
    vi.resetModules();
    const again = await import("./pending-ask");
    expect(again.usePendingAsks.getState().take("p1")).toBeUndefined();
    expect(again.loadPendingAsks()).toEqual({});
  });

  it("is kept per person (the key comes from personKey)", async () => {
    vi.doMock("@/studio/lib/dev-principal", () => ({ personKey: (k: string) => `${k}:user:dev-abcd` }));
    const mod = await import("./pending-ask");
    mod.usePendingAsks.getState().queue("p1", "Hi");
    expect(Object.keys(sessionStorage).some((k) => k.endsWith(":user:dev-abcd"))).toBe(true);
    vi.doUnmock("@/studio/lib/dev-principal");
  });

  it("ignores garbled storage", async () => {
    const { loadPendingAsks, usePendingAsks } = await import("./pending-ask");
    usePendingAsks.getState().queue("p1", "Hi");
    const key = Object.keys(sessionStorage)[0];
    sessionStorage.setItem(key, "{");
    expect(loadPendingAsks()).toEqual({});
  });
});

describe("pending asks (todo15 D4)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.resetModules();
  });

  it("keeps a drop queued with no text, so the drawer still sends it and the reply lands in the drop's conversation", async () => {
    const { usePendingAsks } = await import("./pending-ask");
    const drop = { dropId: "drop-1", messageId: "msg-1" };
    usePendingAsks.getState().queue("p1", "", drop);
    expect(usePendingAsks.getState().take("p1")).toEqual({ text: "", drop });
    expect(usePendingAsks.getState().take("p1")).toBeUndefined();
  });
});
