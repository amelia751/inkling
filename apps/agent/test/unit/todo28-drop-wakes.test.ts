import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@studio/agent-protocol";
import { createLogger } from "../../src/log.ts";
import { DropWakes, SUBSCRIBER } from "../../src/runtime/drop-wakes.ts";
import { decide } from "../../src/tools/policy.ts";
import { dropCounts, safeSummary } from "../../src/tools/drops.ts";
import { harness } from "./harness.ts";

/**
 * todo28 W3: the assistant acts on what's ready and comes back when needed. A drop is read at
 * once (no waiting for checking), the first turn boots on the ready files with `dropId`, and the
 * kernel's drop milestones (claimed as `agent-drops`) wake the chat: a kind waiting patches the
 * attached Studio, nothing to decide makes no model call, and a drop gets at most 4 wake-ups.
 */

const KTOKEN = "kernel-session-token-0123456789";
const SVC = "agent-service-token-0123456789";
const DROP = "drp-0123456789abcdef01234567";
const CONV = "conv-todo28-chat-0001";
const IMG = "studio.image2d.dataKinds.raster";
const ECG = "studio.timeseries.dataKinds.multichannel-timeseries";

/** Mid-check: 2 images ready, 3 files still checking (W2's per-file counts). */
const SUMMARY = {
  dropId: DROP,
  origin: "chat",
  state: "inspecting",
  total: 5,
  byKind: { [IMG]: 2 },
  bytes: 10,
  states: { ready: 2, checking: 3 },
  ready: 2,
  inStudio: 0,
  checking: 3,
  failed: 0,
  groups: [{ groupId: "g1", kind: IMG, count: 2, suggestedAction: "new_studio" }],
  files: [
    { nodeId: "nod-1", agentName: "a.png", kind: IMG, state: "ready" },
    { nodeId: "nod-2", agentName: "b.png", kind: IMG, state: "ready" },
    { nodeId: "nod-3", agentName: "c.dat", state: "checking", retrying: true },
  ],
};

function fakeKernel() {
  const seen: { method: string; path: string; body?: any }[] = [];
  const queue: any[] = [];
  const acked: string[] = [];
  let summary: Record<string, unknown> = SUMMARY;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const send = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/title")) return send(200, {});
    seen.push({ method, path: url.pathname, body });
    if (url.pathname.startsWith("/api/v1/worker/subscriptions/")) {
      if (h.get("authorization") !== `Bearer ${SVC}`) return send(401, {});
      if (url.pathname.endsWith("/claim")) return send(200, { events: queue.filter((e) => !acked.includes(e.eventId)) });
      acked.push(...body.eventIds);
      return send(200, { acked: body.eventIds.length });
    }
    if (h.get("authorization") !== `Bearer ${KTOKEN}`) return send(401, { detail: "invalid token" });
    if (url.pathname === "/api/v1/org") return send(200, { aiAssist: true });
    if (url.pathname === "/api/v1/projects/demo/overview") return send(200, { tasks: [] });
    if (url.pathname === `/api/v1/drops/${DROP}`) return send(200, summary);
    if (method === "POST" && url.pathname === "/api/v1/projects/demo/boots") return send(202, { bootId: body.bootId, taskIds: ["tsk-1"], state: "ready", preset: body.preset, ms: 50 });
    if (method === "GET" && url.pathname === "/api/environments/tsk-1") return send(200, { revision: 1, environment: { extends: "preset:image-2d" } });
    if (method === "PATCH" && url.pathname === "/api/environments/tsk-1") return send(200, { revision: 2, environment: {} });
    return send(404, { detail: "no route" });
  }) as typeof fetch;
  return {
    seen,
    acked,
    fetchImpl,
    setSummary: (s: Record<string, unknown>) => void (summary = s),
    publish: (eventId: string, type: string, payload: Record<string, unknown>) => queue.push({ eventId, type, workspaceId: "demo", payload: { dropId: DROP, conversationId: CONV, ...payload } }),
  };
}

const FIXTURE = {
  scripts: [
    {
      when: "^<drop_update",
      turns: [
        { toolCalls: [{ name: "patch_studio", arguments: { taskId: "tsk-1", revision: 1, patch: [{ op: "add", path: `/data/kinds/${ECG}`, value: { profile: "preset:ecg" } }] } }] },
        { text: "The ECGs are ready too: I added them to the same Studio." },
      ],
    },
    {
      when: "^<drop id",
      turns: [{ toolCalls: [{ name: "boot_studio", arguments: { accepts: [IMG], dropId: DROP, name: "Images" } }] }, { text: "Your Studio opened on the 2 ready images; 3 files are still being checked." }],
    },
  ],
};

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function setup() {
  const k = fakeKernel();
  h = await harness(FIXTURE, {}, [], { fetchImpl: k.fetchImpl });
  const s = await h.json("POST", "/v1/sessions", { sessionId: CONV, projectId: "demo", profile: "assistant", clientTools: [], kernelToken: KTOKEN });
  expect(s.status).toBe(201);
  const wakes = new DropWakes({ kernelUrl: h.config.kernelUrl, token: SVC, sessions: h.sessions, log: createLogger("silent"), fetchImpl: k.fetchImpl });
  return { k, wakes };
}

describe("todo28 W3: act on what's ready", () => {
  it("get_drop's counts read per file, never one status", () => {
    const s = safeSummary(SUMMARY);
    expect(dropCounts(s)).toBe("2 ready · 3 checking");
    expect(s.readyByKind).toEqual({ [IMG]: 2 });
    expect(s.checkingByKind).toEqual({ unknown: 1 });
    expect(dropCounts(safeSummary({ ...SUMMARY, ready: 12, checking: 22, failed: 1 }))).toBe("12 ready · 22 checking · 1 kept");
  });

  it("the first turn boots on the first ready images with dropId, without waiting for checking", async () => {
    const { k } = await setup();
    const t0 = Date.now();
    const m = await h!.json("POST", `/v1/sessions/${CONV}/messages`, { text: "", drop: { dropId: DROP }, kernelToken: KTOKEN });
    expect(m.status).toBe(202);
    expect(Date.now() - t0).toBeLessThan(2_000);
    const events: AgentEvent[] = await h!.drive(m.body.runId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    const boot = k.seen.find((c) => c.method === "POST" && c.path.endsWith("/boots"));
    expect(boot?.body).toMatchObject({ dropId: DROP, accepts: [IMG] });
    // The tool result's note ("the other files join this Studio as they're checked") is covered in studio-tools.
    expect(events.some((e) => e.type === "tool-result" && e.ok)).toBe(true);
    // Read once for the message: the drop had files, so no polling.
    expect(k.seen.filter((c) => c.path === `/api/v1/drops/${DROP}`)).toHaveLength(1);
  });

  it("a wake on kind_waiting patches the attached Studio to add the kind, under the wake policy", async () => {
    const { k, wakes } = await setup();
    k.setSummary({ ...SUMMARY, studioTaskId: "tsk-1", waitingForKind: { [ECG]: 3 }, checking: 0 });
    k.publish("evt-1", "drop.kind_waiting", { kind: ECG, count: 3 });
    expect(await wakes.tick()).toEqual({ [DROP]: "started" });
    expect(k.acked).toEqual(["evt-1"]);
    const ctx = await h!.sessions.get(CONV);
    expect(ctx.policy.wake).toEqual({ taskId: "tsk-1" });
    const events: AgentEvent[] = await h!.drive(ctx.activeRun!.id);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    const patch = k.seen.find((c) => c.method === "PATCH" && c.path === "/api/environments/tsk-1");
    expect(patch?.body.patch[0].path).toBe(`/data/kinds/${ECG}`);
  });

  it("a wake with nothing to decide makes no model call", async () => {
    const { k, wakes } = await setup();
    k.publish("evt-1", "drop.settled", { inStudio: 5, waitingForKind: {}, failed: 0 });
    expect(await wakes.tick()).toEqual({ [DROP]: "nothing" });
    expect(k.acked).toEqual(["evt-1"]);
    const ctx = await h!.sessions.get(CONV);
    expect(ctx.activeRun).toBeUndefined();
    expect(k.seen.some((c) => c.path.endsWith("/environments/tsk-1") || c.path.endsWith("/boots"))).toBe(false);
  });

  it("coalesces within 15 s, caps a drop at 4 wake-ups (the fifth milestone is dropped), and posts a status line when the token is gone", async () => {
    const { k } = await setup();
    const ctx = await h!.sessions.get(CONV);
    // An expired token: no model call, a plain status line instead.
    ctx.kernelTokenAt = Date.now() - 60 * 60_000;
    let now = Date.now();
    const wakes = new DropWakes({ kernelUrl: h!.config.kernelUrl, token: SVC, sessions: h!.sessions, log: createLogger("silent"), fetchImpl: k.fetchImpl, now: () => now });
    const outcomes: string[] = [];
    for (let i = 1; i <= 5; i++) {
      k.publish(`evt-${i}`, "drop.files_failed", { count: i, reasons: [{ reason: "We couldn't read this file", count: i }] });
      if (i === 2) {
        // Within 15 s of the first: left unacked, delivered on a later claim.
        now += 1_000;
        expect(await wakes.tick()).toEqual({ [DROP]: "coalesced" });
        expect(k.acked).not.toContain("evt-2");
      }
      now += 16_000;
      outcomes.push((await wakes.tick())[DROP]!);
    }
    expect(outcomes).toEqual(["status", "status", "status", "status", "capped"]);
    expect(k.acked).toEqual(["evt-1", "evt-2", "evt-3", "evt-4", "evt-5"]);
    expect(ctx.activeRun).toBeUndefined();
    expect(ctx.meta.drops?.[DROP]?.wakes).toBe(4);
  });

  it("the wake policy allows reads and a patch of the attached Studio only, at most 4 calls", () => {
    const s = { toolCalls: 0, startedAt: Date.now(), spendUsd: 0, restricted: false, egressContained: false, userText: "", wake: { taskId: "tsk-1" } };
    const b = { maxToolCalls: 50, maxRunSeconds: 600, maxSpendUsd: 5 };
    expect(decide({ toolName: "patch_studio", input: { taskId: "tsk-1" } }, s, b).kind).toBe("allow");
    expect(decide({ toolName: "patch_studio", input: { taskId: "tsk-9" } }, s, b)).toMatchObject({ kind: "deny", soft: true });
    expect(decide({ toolName: "boot_studio", input: {} }, s, b)).toMatchObject({ kind: "deny", soft: true });
    expect(decide({ toolName: "activate_plugin", input: {} }, s, b)).toMatchObject({ kind: "deny" });
    expect(decide({ toolName: "get_drop", input: {} }, { ...s, toolCalls: 4 }, b)).toMatchObject({ kind: "deny" });
    expect(SUBSCRIBER).toBe("agent-drops");
  });
});
