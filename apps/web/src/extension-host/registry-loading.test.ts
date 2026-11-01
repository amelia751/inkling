import { describe, expect, it } from "vitest";
import { defineModule, type ModuleImpl } from "@studio/plugin-ui-sdk/module";
import { createRegistry } from "./registry";

/** Module loading without the boot gate (todo11 Milestone 1): per-module state, ensure, retry. */
const Panel = () => null;

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

const mod = (id: string, load: () => Promise<ModuleImpl>) =>
  defineModule({ id, version: "1.0.0", title: id, description: id, contributes: { panels: [{ id: "p", title: "P", slot: "right", description: "P" }] }, load });

describe("registry module loading", () => {
  it("reports idle → loading → ready, and peekImpl answers once ready", async () => {
    const d = deferred<ModuleImpl>();
    const r = createRegistry([mod("t.a", () => d.promise)]);
    expect(r.moduleState("t.a").status).toBe("idle");
    expect(r.moduleOf("t.a.panels.p")).toBe("t.a");
    r.ensure("t.a");
    expect(r.moduleState("t.a").status).toBe("loading");
    expect(r.peekImpl("t.a.panels.p")).toBeUndefined();
    d.resolve({ panels: { p: Panel } });
    await r.preload("t.a");
    expect(r.moduleState("t.a").status).toBe("ready");
    expect(r.isLoaded("t.a")).toBe(true);
    expect(r.peekImpl("t.a.panels.p")).toBe(Panel);
  });

  it("keeps one module's failure to itself and retries on demand", async () => {
    let fail = true;
    const r = createRegistry([
      mod("t.ok", async () => ({ panels: { p: Panel } })),
      mod("t.bad", async () => {
        if (fail) throw new Error("chunk failed");
        return { panels: { p: Panel } };
      }),
    ]);
    r.ensure("t.bad");
    r.ensure("t.ok");
    await expect(r.preload("t.bad")).rejects.toThrow("chunk failed");
    await r.preload("t.ok");
    expect(r.moduleState("t.bad")).toMatchObject({ status: "failed" });
    expect(r.moduleState("t.bad").error?.message).toBe("chunk failed");
    expect(r.peekImpl("t.ok.panels.p")).toBe(Panel);
    // ensure() doesn't hammer a failed module; retry() does.
    r.ensure("t.bad");
    expect(r.moduleState("t.bad").status).toBe("failed");
    fail = false;
    r.retry("t.bad");
    expect(r.moduleState("t.bad").status).toBe("loading");
    await r.preload("t.bad");
    expect(r.moduleState("t.bad").status).toBe("ready");
  });

  it("loads a module once however often it's asked for, notifying subscribers", async () => {
    let loads = 0;
    const r = createRegistry([mod("t.a", async () => (loads++, { panels: { p: Panel } }))]);
    let notified = 0;
    r.subscribe(() => notified++);
    r.ensure("t.a");
    r.ensure("t.a");
    await Promise.all([r.preload("t.a"), r.preload("t.a")]);
    await r.preload("t.a");
    expect(loads).toBe(1);
    expect(notified).toBe(2); // loading, ready
  });
});
