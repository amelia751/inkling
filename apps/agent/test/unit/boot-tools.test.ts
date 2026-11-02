import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STUDIO_TOOL_NAMES } from "@studio/studio-tools";
import { loadStudioCatalog } from "../../src/agent/catalog.ts";
import { PROFILES, systemPrompt } from "../../src/agent/profiles.ts";
import { NAMING } from "../../src/naming.ts";
import { ENV_TOOLS, harness } from "./harness.ts";

/**
 * todo11 Milestone 2 item 6: the Studio tools are server tools that call the API's boot and
 * environment routes with the session's kernel token; boot_studio runs only on explicit creation
 * intent, is idempotent per call, and reports API refusals so the model can act on them. The
 * ~30 KB browser catalogue is no longer in the system prompt.
 */

const KTOKEN = "kernel-session-token-0123456789";
const CATALOG_MD = readFileSync(resolve(import.meta.dirname, "../../../../schemas/catalog.md"), "utf8");

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  workspace: string | null;
  run: string | null;
  body?: any;
}

/** A fake API: boots are idempotent on bootId; `mode` picks a refusal. */
function fakeApi(mode: "ok" | "422" | "403" | "ai-off" | "empty-project" = "ok") {
  const seen: Seen[] = [];
  const boots = new Map<string, { bootId: string; taskIds: string[]; state: string; preset: string; ms: number }>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? "GET";
    seen.push({ method, path: url.pathname, auth: h.get("authorization"), workspace: h.get("x-workspace-id"), run: h.get("x-agent-run"), body });
    const send = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (h.get("authorization") !== `Bearer ${KTOKEN}`) return send(401, { detail: "invalid token" });
    if (method === "GET" && url.pathname === "/api/v1/org") return send(200, { aiAssist: mode !== "ai-off" });
    if (method === "GET" && url.pathname === "/api/v1/projects/demo/overview") return send(200, { tasks: mode === "empty-project" ? [] : [{ id: "tsk-0" }] });
    if (method === "POST" && url.pathname === "/api/v1/projects/demo/boots") {
      if (mode === "422") return send(422, { ok: false, errors: [{ path: "/labels/0/control", code: "reference", message: "unknown label control Nope" }] });
      if (mode === "403") return send(403, { detail: { ok: false, error: "outside agent scope", errors: [{ path: "/data", code: "scope", message: "agents may not change /data" }] } });
      const b = boots.get(body.bootId) ?? { bootId: body.bootId, taskIds: [`tsk-${boots.size + 1}`], state: "ready", preset: body.preset, ms: 140 };
      boots.set(body.bootId, b);
      return send(202, b);
    }
    if (method === "GET" && url.pathname.startsWith("/api/environments/")) return send(200, { revision: 1, environment: { extends: "preset:image-2d" }, effective: { big: "x".repeat(10_000) } });
    if (method === "PATCH" && url.pathname.startsWith("/api/environments/"))
      return body.revision === 1 ? send(200, { revision: 2, environment: {}, contentHash: "h2", author: "agent:run" }) : send(409, { error: "stale revision", current: 2 });
    return send(404, { detail: "no route" });
  }) as typeof fetch;
  return { seen, boots, fetchImpl };
}

const BOOT = { toolCalls: [{ name: "boot_studio", arguments: { intent: "chest x-ray", name: "CXR triage", patch: [{ op: "add", path: "/labels", value: [{ name: "finding", control: "Choices", classes: [{ id: "normal" }] }] }] } }] };
const FIXTURE = {
  scripts: [
    { when: "^create", turns: [BOOT, { text: "Your chest X-ray Studio is ready." }] },
    { when: "^retry", turns: [{ toolCalls: [{ name: "boot_studio", arguments: { preset: "preset:image-2d", bootId: "boot_fixed" } }] }, { toolCalls: [{ name: "boot_studio", arguments: { preset: "preset:image-2d", bootId: "boot_fixed" } }] }, { text: "Done." }] },
    { when: "^could", turns: [BOOT, { toolCalls: [{ name: "offer_studio", arguments: { preset: "preset:image-2d", title: "Create X-ray Studio", reason: "Triage chest X-rays" } }] }, { text: "Click to create it." }] },
    { when: "^stale", turns: [{ toolCalls: [{ name: "patch_studio", arguments: { taskId: "tsk-1", revision: 0, patch: [{ op: "replace", path: "/title", value: "X" }] } }] }, { text: "Stale." }] },
    { when: "^chest", turns: [BOOT, { text: "Your chest X-ray Studio is ready." }] },
    { when: "^find", turns: [{ toolCalls: [{ name: "search_catalog", arguments: { query: "polygon tool" } }] }, { text: "Found." }] },
  ],
};

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function session(api: ReturnType<typeof fakeApi>, profile = "environment-designer", catalogPrompt?: string) {
  h = await harness(FIXTURE, {}, [], { fetchImpl: api.fetchImpl });
  const s = await h.json("POST", "/v1/sessions", { projectId: "demo", profile, clientTools: profile === "assistant" ? [] : ENV_TOOLS, kernelToken: KTOKEN, catalogPrompt });
  expect(s.status).toBe(201);
  return s.body.sessionId as string;
}

async function say(id: string, text: string) {
  const r = await h!.json("POST", `/v1/sessions/${id}/messages`, { text });
  expect(r.status).toBe(202);
  return h!.drive(r.body.runId);
}

/** The JSON text of each tool result the model saw, in order. */
async function toolResults(id: string) {
  const msgs = (await h!.sessions.get(id)).piSession.messages as any[];
  return msgs.filter((m) => m.role === "toolResult").map((m) => ({ name: m.toolName as string, isError: !!m.isError, text: (m.content as any[]).map((c) => c.text ?? "").join("") }));
}

describe("Studio server tools", () => {
  it("boot_studio posts the boot route at once, preset from the intent table, with the session token", async () => {
    const api = fakeApi();
    const id = await session(api);
    const events = await say(id, "Create a chest X-ray Studio with five classification labels");
    const post = api.seen.find((s) => s.method === "POST")!;
    expect(post.path).toBe("/api/v1/projects/demo/boots");
    expect(post.auth).toBe(`Bearer ${KTOKEN}`);
    expect(post.workspace).toBe("demo");
    expect(post.run).toMatch(/^run_/);
    expect(post.body).toMatchObject({ preset: "preset:image-2d", name: "CXR triage", intent: "chest x-ray", patch: [{ op: "add", path: "/labels" }] });
    expect(post.body.bootId).toMatch(/^boot_[0-9a-f]{24}$/);
    const [r] = await toolResults(id);
    expect(r!.isError).toBe(false);
    const result = JSON.parse(r!.text);
    expect(result).toMatchObject({ bootId: post.body.bootId, taskId: "tsk-1", taskIds: ["tsk-1"], state: "ready", preset: "preset:image-2d", presetFrom: "intent", revision: 1, draft: true });
    // Small result: no resolved environment, no bytes.
    expect(r!.text.length).toBeLessThan(600);
    expect(events.some((e) => e.type === "tool-result" && e.ok)).toBe(true);
  });

  it("same bootId on retry → the same boot, no second task", async () => {
    const api = fakeApi();
    const id = await session(api);
    await say(id, "retry: create an x-ray studio");
    const posts = api.seen.filter((s) => s.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body.bootId).toBe("boot_fixed");
    expect(api.boots.size).toBe(1);
    const results = (await toolResults(id)).map((r) => JSON.parse(r.text));
    expect(results[0].taskIds).toEqual(results[1].taskIds);
  });

  it("derived bootIds are stable for a run + call id and differ across calls", async () => {
    const { createStudioTools } = await import("../../src/tools/studio.ts");
    const { StudioClient } = await import("@studio/studio-tools");
    const api = fakeApi();
    const tools = createStudioTools({ client: new StudioClient({ baseUrl: "http://api.test", token: () => KTOKEN, fetch: api.fetchImpl }), studio: loadStudioCatalog({ studioFiles: { catalog: undefined, intents: undefined } }), projectId: "demo", runId: () => "run_1" });
    const boot = tools.find((t) => t.name === "boot_studio")!;
    const call = (callId: string) => boot.execute(callId, { preset: "preset:ecg" } as never, undefined, undefined, undefined as never);
    await call("call_a");
    await call("call_a");
    await call("call_b");
    const ids = api.seen.filter((s) => s.method === "POST").map((s) => s.body.bootId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(api.boots.size).toBe(2);
  });

  it("an idea floated as a question gets no boot: the policy refuses and the model offers a card", async () => {
    const api = fakeApi();
    const id = await session(api);
    await say(id, "could we make a chest X-ray Studio?");
    expect(api.seen.filter((s) => s.method === "POST")).toHaveLength(0);
    const [denied, offer] = await toolResults(id);
    expect(denied!.isError).toBe(true);
    expect(denied!.text).toMatch(/offer_studio/);
    expect(JSON.parse(offer!.text).offer).toEqual({ preset: "preset:image-2d", title: "Create X-ray Studio", reason: "Triage chest X-rays" });
  });

  it.each(["422", "403"] as const)("a %s is a tool error the model can read (status, errors with paths)", async (mode) => {
    const api = fakeApi(mode);
    const id = await session(api);
    await say(id, "Create a chest X-ray Studio");
    const [r] = await toolResults(id);
    expect(r!.isError).toBe(true);
    const err = JSON.parse(r!.text);
    expect(err.status).toBe(Number(mode));
    expect(err.errors[0]).toMatchObject({ path: mode === "422" ? "/labels/0/control" : "/data", code: mode === "422" ? "reference" : "scope" });
  });

  it("patch_studio sends the revision and reports a stale one with the current revision", async () => {
    const api = fakeApi();
    const id = await session(api);
    await say(id, "stale title change");
    expect(api.seen.find((s) => s.method === "PATCH")!.body).toEqual({ patch: [{ op: "replace", path: "/title", value: "X" }], revision: 0 });
    const [r] = await toolResults(id);
    expect(r!.isError).toBe(true);
    expect(JSON.parse(r!.text)).toMatchObject({ status: 409, current: 2 });
  });

  it("search_catalog answers from schemas/catalog.json", async () => {
    const api = fakeApi();
    const id = await session(api, "assistant");
    await say(id, "find a polygon tool");
    const [r] = await toolResults(id);
    expect(JSON.parse(r!.text).results[0].id).toMatch(/\.tools\.polygon$/);
    // Only the per-message preflight reads (todo15: org aiAssist, whether the project has a task).
    expect(api.seen.filter((s) => !/\/api\/v1\/(org|projects\/[^/]+\/overview)$/.test(s.path))).toHaveLength(0);
  });
});

describe("prompt and tool list", () => {
  it("the browser's catalogue is no longer injected; the compact index is", async () => {
    const api = fakeApi();
    const id = await session(api, "environment-designer", `catalogue head\n\n${CATALOG_MD}`);
    const sys = (await h!.sessions.get(id)).piSession.systemPrompt;
    expect(sys).not.toContain("environment catalogue");
    expect(sys).not.toContain("catalogue head");
    expect(sys).toContain("- preset:image-2d: ");
    expect(sys).toContain("search_catalog");
    expect(sys).not.toContain("{{displayName}}");
    expect(sys).toContain(NAMING.displayName);
    expect(sys.length).toBeLessThan(CATALOG_MD.length / 2);
    // Only pi's own <cwd> line follows the static index.
    expect(sys.indexOf(h!.sessions.studio.index)).toBeGreaterThan(0);
    expect(sys.slice(sys.indexOf(h!.sessions.studio.index) + h!.sessions.studio.index.length).trim()).toMatch(/^<cwd>[^]*<\/cwd>$/);
  });

  it("system prompt and tool list are identical across sessions, in a fixed order", async () => {
    const api = fakeApi();
    const a = await session(api);
    const s1 = await h!.sessions.get(a);
    // Same profile, browser tools in another order.
    const b = await h!.json("POST", "/v1/sessions", { projectId: "demo", profile: "environment-designer", clientTools: [...ENV_TOOLS].reverse(), kernelToken: KTOKEN });
    const s2 = await h!.sessions.get(b.body.sessionId);
    expect(s2.piSession.systemPrompt).toBe(s1.piSession.systemPrompt);
    const names = (s: typeof s1) => s.piSession.getAllTools().map((t) => t.name);
    expect(names(s2)).toEqual(names(s1));
    const studio = names(s1).filter((n) => (STUDIO_TOOL_NAMES as readonly string[]).includes(n));
    expect(studio).toEqual(["boot_studio", "patch_studio", "get_studio_state", "search_catalog", "offer_studio"]);
  });

  it("the boot prompt goes to the profiles with Studio tools, last, before the index", () => {
    for (const p of ["assistant", "environment-designer", "coder"] as const) {
      expect(PROFILES[p].studio).toBe(true);
      expect(PROFILES[p].prompts.at(-1)).toBe("boot");
    }
    expect(PROFILES.task.studio).toBeFalsy();
    const sys = systemPrompt(PROFILES.assistant, { studioIndex: "INDEX", dynamic: ["LAST"] });
    expect(sys.indexOf("INDEX")).toBeGreaterThan(sys.indexOf("boot_studio"));
    expect(sys.endsWith("INDEX\n\nLAST")).toBe(true);
  });

  it("todo15 D3: a described task boots in a project without a Studio, not in one that has one", async () => {
    let api = fakeApi("empty-project");
    let id = await session(api, "assistant");
    await say(id, "chest X-ray classification with five labels");
    expect(api.seen.filter((s) => s.method === "POST" && s.path.endsWith("/boots"))).toHaveLength(1);
    await h!.cleanup();
    api = fakeApi();
    id = await session(api, "assistant");
    await say(id, "chest X-ray classification with five labels");
    expect(api.seen.filter((s) => s.method === "POST" && s.path.endsWith("/boots"))).toHaveLength(0);
    expect((await toolResults(id))[0]).toMatchObject({ name: "boot_studio", isError: true });
  });

  it("todo15 D2: refuses runs with 403 ai_assist_off when the org turned the assistant off", async () => {
    const api = fakeApi("ai-off");
    const id = await session(api, "assistant");
    const r = await h!.json("POST", `/v1/sessions/${id}/messages`, { text: "hello" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "ai_assist_off", message: "The assistant is off for this organization" });
  });
});
