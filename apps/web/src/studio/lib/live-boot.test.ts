import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

vi.mock("@studio/ui/ui/sonner", () => ({ toast: vi.fn() }));
// The resolver and module loading are covered elsewhere; here an env is its source.
vi.mock("@/extension-host/resolve", () => ({ resolveEnvironment: (spec: unknown) => ({ env: { id: "env", source: spec, tools: [] } }) }));
vi.mock("@/extension-host/registry", () => ({ registry: { preload: async () => undefined } }));
vi.mock("./boot-priority", () => ({ newModules: () => [] }));
// The composition root registers every plugin; the boot helpers only need its intent table.
vi.mock("@/extension-host/bundled", () => ({ INTENT_TABLE: JSON.parse(readFileSync(join(__dirname, "../../../../../registry/intents.json"), "utf8")) }));

const { emitProjectEvent } = await import("./use-project-events");
const { useBoots, bootRows } = await import("@/studio/stores/boots");
const { useAgent } = await import("@/studio/stores/agent");
const { useStudio } = await import("@/studio/stores/studio");
const { applyEnvironmentUpdate } = await import("./live-environment");
const { noteRevision } = await import("./environment-edits");
const { presetFor, studioName, STUDIO_COMMAND } = await import("./studio-boot");

describe("boots store (project boot.* events)", () => {
  beforeEach(() => {
    useBoots.setState({ boots: {}, pendingNav: null });
    useAgent.setState({ threads: { p1: [{ id: "m1", role: "assistant", parts: [] }] }, active: { projectId: "p1", runId: "run_a", messageId: "m1", lastSeq: 0, answered: [] } });
  });

  it("the tab streaming the run navigates itself and gets the card in its thread", () => {
    emitProjectEvent("boot.started", { bootId: "boot_1", taskIds: ["t1"], preset: "preset:image-2d", initiator: { kind: "agent", runId: "run_a" } }, "p1");
    expect(useBoots.getState().boots.boot_1.own).toBe(true);
    expect(useBoots.getState().pendingNav).toEqual({ bootId: "boot_1", url: "/projects/p1/studio/t1" });
    expect(useAgent.getState().threads.p1[0].parts).toEqual([{ type: "boot", id: "boot_1" }]);
  });

  it("other boots get a link, never a navigation; steps and ready land on the card", () => {
    emitProjectEvent("boot.started", { bootId: "boot_2", taskIds: ["t2"], preset: "preset:ecg", initiator: { kind: "agent", runId: "run_other" } }, "p1");
    expect(useBoots.getState().pendingNav).toBeNull();
    let b = useBoots.getState().boots.boot_2;
    expect(bootRows(b).map((r) => [r.step, r.state])).toEqual([
      ["task", "active"],
      ["environment", "pending"],
    ]);
    emitProjectEvent("boot.step", { bootId: "boot_2", step: "environment", state: "done", label: "Set up from preset:ecg" }, "p1");
    emitProjectEvent("boot.step", { bootId: "boot_2", step: "task", state: "done", label: "Created draft “ECG Studio”" }, "p1");
    emitProjectEvent("boot.step", { bootId: "boot_2", step: "refine", state: "done", label: "Added 5 labels" }, "p1");
    // A replayed event doesn't add a row.
    emitProjectEvent("boot.step", { bootId: "boot_2", step: "refine", state: "done", label: "Added 5 labels" }, "p1");
    emitProjectEvent("boot.ready", { bootId: "boot_2", taskIds: ["t2"], ms: 140 }, "p1");
    b = useBoots.getState().boots.boot_2;
    expect(b.state).toBe("ready");
    expect(b.ms).toBe(140);
    expect(bootRows(b).map((r) => r.label)).toEqual(["Created draft “ECG Studio”", "Set up from preset:ecg", "Added 5 labels"]);
    expect(useBoots.getState().pendingNav).toBeNull();
  });

  it("a failed boot shows its failing step", () => {
    emitProjectEvent("boot.failed", { bootId: "boot_3", step: "task", message: "boom" }, "p1");
    const b = useBoots.getState().boots.boot_3;
    expect(b.state).toBe("failed");
    expect(bootRows(b)).toEqual([{ step: "task", state: "failed", label: "boom" }]);
  });

  it("Stop keeps what's built", () => {
    emitProjectEvent("boot.started", { bootId: "boot_4", taskIds: ["t4"], preset: "preset:video", initiator: { kind: "person" } }, "p1");
    emitProjectEvent("boot.step", { bootId: "boot_4", step: "task", state: "done", label: "Created draft" }, "p1");
    useBoots.getState().stop("boot_4");
    const b = useBoots.getState().boots.boot_4;
    expect(b.state).toBe("stopped");
    expect(b.steps).toHaveLength(1);
    emitProjectEvent("boot.ready", { bootId: "boot_4", taskIds: ["t4"], ms: 5 }, "p1");
    expect(useBoots.getState().boots.boot_4.state).toBe("stopped");
  });

  it("a person's boot from this tab navigates once, from the route's answer or the event", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bootId: "x", taskIds: ["t5"], state: "ready", ms: 9 }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const b = await useBoots.getState().start("p1", { bootId: "boot_5abcdef", preset: "preset:image-2d", name: "Chest x-ray Studio" });
    expect(b.state).toBe("ready");
    expect(useBoots.getState().pendingNav?.url).toBe("/projects/p1/studio/t5");
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ bootId: "boot_5abcdef", preset: "preset:image-2d", name: "Chest x-ray Studio" });
    useBoots.getState().clearNav();
    emitProjectEvent("boot.started", { bootId: "boot_5abcdef", taskIds: ["t5"], preset: "preset:image-2d", initiator: { kind: "person" } }, "p1");
    expect(useBoots.getState().pendingNav).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("live environment updates", () => {
  const qc = new QueryClient();
  const base = { extends: "preset:image-2d" };
  beforeEach(() => {
    useStudio.setState({ projectId: "t1", env: { id: "env", source: base } as never });
    qc.setQueryData(["environment", "t1"], { revision: 1, environment: base });
    noteRevision("t1", 1);
  });

  it("applies the next revision's patch, ignores its own and older revisions", async () => {
    const patch = [{ op: "add" as const, path: "/labels", value: [{ id: "findings", classes: [{ id: "a" }] }] }];
    expect(await applyEnvironmentUpdate(qc, "t1", { taskId: "t1", revision: 2, patch })).toBe("patched");
    expect((useStudio.getState().env!.source as { labels?: unknown[] }).labels).toHaveLength(1);
    expect(await applyEnvironmentUpdate(qc, "t1", { taskId: "t1", revision: 2, patch })).toBe("ignored");
    expect(await applyEnvironmentUpdate(qc, "t1", { taskId: "t1", revision: 1 })).toBe("ignored");
    expect(await applyEnvironmentUpdate(qc, "t1", { taskId: "other", revision: 9 })).toBe("ignored");
    expect((qc.getQueryData(["environment", "t1"]) as { revision: number }).revision).toBe(2);
  });

  it("refetches without a patch or after a gap", async () => {
    const fresh = { ...base, title: "Fresh" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ revision: 7, environment: fresh }), { status: 200, headers: { "Content-Type": "application/json" } })));
    expect(await applyEnvironmentUpdate(qc, "t1", { taskId: "t1", revision: 7, patch: [{ op: "add", path: "/title", value: "x" }] })).toBe("refetched");
    expect((useStudio.getState().env!.source as { title?: string }).title).toBe("Fresh");
    vi.unstubAllGlobals();
  });
});

describe("explicit boots from the person", () => {
  it("picks the preset from the shared intent table", () => {
    expect(presetFor("chest x-ray")?.preset).toBe("preset:image-2d");
    expect(presetFor("12-lead ECG")?.preset).toBe("preset:ecg");
    expect(presetFor("")).toBeNull();
    expect(studioName("chest x-ray")).toBe("Chest x-ray Studio");
    expect(STUDIO_COMMAND.exec("/studio chest x-ray")?.[1]).toBe("chest x-ray");
    expect(STUDIO_COMMAND.test("/studios")).toBe(false);
  });
});

describe("D4 rule 3: only the agent store consumes raw run events", () => {
  it("no other web file names AgentEvent", () => {
    const src = join(__dirname, "..", "..");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.tsx?$/.test(n) && !n.endsWith(".test.ts") ? [join(d, n)] : []));
    const users = walk(src)
      .filter((f) => /\bAgentEvent\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f));
    // The store reduces them; the client is the transport that hands them to it.
    expect(users.sort()).toEqual(["studio/lib/agent/client.ts", "studio/stores/agent.ts"]);
  });
});
