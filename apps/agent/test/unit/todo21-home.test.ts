import { afterEach, describe, expect, it } from "vitest";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decide } from "../../src/tools/policy.ts";
import { projectMetadata } from "../../src/tools/home.ts";
import { ENV_TOOLS, harness } from "./harness.ts";

/**
 * todo21: chats run side by side (D6), a stale Studio write is a result the model acts on (D6),
 * Home chats only route (D8) and a project chat's tools reach only its project (D9).
 */

type H = Awaited<ReturnType<typeof harness>>;
let h: H | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const KTOKEN = "kernel-session-token-0123456789";

/** A tool that blocks until the test releases it, so two runs overlap for sure. */
function gate() {
  const started: string[] = [];
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  const tool = defineTool({
    name: "hold",
    label: "Holding",
    description: "Wait.",
    parameters: Type.Object({ tag: Type.String() }),
    async execute(_id, args) {
      started.push(args.tag);
      await opened;
      return { content: [{ type: "text" as const, text: `held ${args.tag}` }], details: { summary: "held" } };
    },
  });
  return { tool, started, open };
}

/** A fake kernel: the project list and per-project reads; everything recorded. */
function fakeKernel(projects: Record<string, unknown>[]) {
  const seen: { method: string; path: string; workspace: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const hd = new Headers(init?.headers);
    seen.push({ method: init?.method ?? "GET", path: url.pathname, workspace: hd.get("x-workspace-id") });
    const send = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (hd.get("authorization") !== `Bearer ${KTOKEN}`) return send(401, { detail: "invalid token" });
    if (url.pathname === "/api/v1/projects") return send(200, { projects });
    const m = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (m) return projects.some((p) => p.id === m[1]) ? send(200, projects.find((p) => p.id === m[1])) : send(404, { detail: "no such project" });
    if (url.pathname === "/api/v1/org") return send(200, { aiAssist: true });
    return send(404, { detail: "no route" });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const PROJECTS = [
  {
    id: "liver-ct",
    title: "Liver CT",
    orgId: "org_1",
    description: "secret notes",
    kinds: [{ kind: "volume", count: 12 }, { kind: "image", count: 3 }],
    lastActivityAt: "2026-11-02T10:00:00Z",
    resume: { nodeName: "patient-042.nii.gz" },
    role: "owner",
  },
  { id: "knee-mri", title: "knee-mri", kinds: [{ kind: "video", count: 2 }], lastActivityAt: null, updatedAt: "2026-11-01T09:00:00Z" },
];

describe("todo21 W2: chats run side by side", { timeout: 30_000 }, () => {
  it("two chats of one project run at the same time, each with its own answer", async () => {
    const g = gate();
    const fixture = {
      scripts: [
        { when: "^first", turns: [{ toolCalls: [{ name: "hold", arguments: { tag: "a" } }] }, { text: "Answer A." }] },
        { when: "^second", turns: [{ toolCalls: [{ name: "hold", arguments: { tag: "b" } }] }, { text: "Answer B." }] },
      ],
    };
    h = await harness(fixture, {}, [g.tool]);
    const base = { projectId: "demo", profile: "environment-designer", clientTools: ENV_TOOLS };
    const a = (await h.json("POST", "/v1/sessions", base)).body.sessionId as string;
    const b = (await h.json("POST", "/v1/sessions", base)).body.sessionId as string;
    const ra = await h.json("POST", `/v1/sessions/${a}/messages`, { text: "first" });
    const rb = await h.json("POST", `/v1/sessions/${b}/messages`, { text: "second" });
    expect([ra.status, rb.status]).toEqual([202, 202]);
    expect(ra.body.steered).toBe(false);
    expect(rb.body.steered).toBe(false);
    expect(ra.body.runId).not.toBe(rb.body.runId);
    // Both runs are inside their tool call at once: the lease is per session, not per project.
    for (let i = 0; i < 200 && g.started.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(g.started.sort()).toEqual(["a", "b"]);
    expect((await h.sessions.store.activeSessionIds()).has(a)).toBe(true);
    expect((await h.sessions.store.activeSessionIds()).has(b)).toBe(true);
    g.open();
    const [ea, eb] = await Promise.all([h.drive(ra.body.runId), h.drive(rb.body.runId)]);
    const text = (es: typeof ea) => es.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(text(ea)).toContain("Answer A.");
    expect(text(ea)).not.toContain("Answer B.");
    expect(text(eb)).toContain("Answer B.");
    expect(ea.at(-1)).toMatchObject({ type: "done", status: "completed" });
    expect(eb.at(-1)).toMatchObject({ type: "done", status: "completed" });
  });

  it("a stale browser environment write is a result telling the model to re-read, not a failed run", async () => {
    const fixture = { scripts: [{ when: "^edit", turns: [{ toolCalls: [{ name: "patch_environment", arguments: { patch: [], summary: "x" } }] }, { text: "Re-reading." }] }] };
    h = await harness(fixture);
    const s = (await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "environment-designer", clientTools: ENV_TOOLS })).body.sessionId as string;
    const r = await h.json("POST", `/v1/sessions/${s}/messages`, { text: "edit it" });
    const events = await h.drive(r.body.runId, async (e) => {
      if (e.type === "client-tool") await h!.json("POST", `/v1/runs/${r.body.runId}/client-tools/${e.callId}`, { ok: false, output: { conflict: true, current: 7 } });
    });
    const msgs = (await h.sessions.get(s)).piSession.messages as any[];
    const result = msgs.find((m) => m.role === "toolResult");
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ conflict: true, detail: { current: 7 } });
    expect(JSON.parse(result.content[0].text).message).toMatch(/Studio changed.*Re-read/);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
  });
});

describe("todo21 W5: Home chats route", { timeout: 30_000 }, () => {
  it("creates a Home session with no project; it lists separately and has exactly the three routing tools", async () => {
    const k = fakeKernel(PROJECTS);
    const extra = gate().tool;
    h = await harness({ scripts: [] }, {}, [extra], { fetchImpl: k.fetchImpl });
    const r = await h.json("POST", "/v1/sessions", { scope: "home", kernelToken: KTOKEN });
    expect(r.status).toBe(201);
    expect(r.body.profile).toBe("home");
    expect(r.body.session).toMatchObject({ scope: "home", projectId: null, profile: "home" });
    await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "environment-designer", clientTools: ENV_TOOLS });
    const home = await h.json("GET", "/v1/sessions?scope=home");
    expect(home.body.sessions.map((s: { id: string }) => s.id)).toEqual([r.body.sessionId]);
    const project = await h.json("GET", "/v1/sessions?scope=project");
    expect(project.body.sessions.map((s: { scope: string; projectId: string }) => [s.scope, s.projectId])).toEqual([["project", "demo"]]);
    // D9: no data tools (and not even test extras) in a Home chat.
    const ctx = await h.sessions.get(r.body.sessionId);
    expect(ctx.piSession.getAllTools().map((t) => t.name).sort()).toEqual(["create_project", "list_projects", "open_in_project"]);
    expect((await h.json("GET", `/v1/sessions/${r.body.sessionId}`)).body.projectId).toBeNull();
  });

  it("refuses a Home chat with a project profile, and a project chat without a project", async () => {
    h = await harness({ scripts: [] });
    expect((await h.json("POST", "/v1/sessions", { scope: "home", profile: "assistant" })).status).toBe(400);
    expect((await h.json("POST", "/v1/sessions", { profile: "home", projectId: "demo" })).status).toBe(400);
    expect((await h.json("POST", "/v1/sessions", { profile: "assistant" })).status).toBe(400);
  });

  it("list_projects returns metadata only: no file names, descriptions or resume rows", async () => {
    const k = fakeKernel(PROJECTS);
    const fixture = { scripts: [{ when: "which", turns: [{ toolCalls: [{ name: "list_projects" }] }, { text: "Liver CT has volumes." }] }] };
    h = await harness(fixture, {}, [], { fetchImpl: k.fetchImpl });
    const sid = (await h.json("POST", "/v1/sessions", { scope: "home", kernelToken: KTOKEN })).body.sessionId as string;
    const run = await h.json("POST", `/v1/sessions/${sid}/messages`, { text: "which of my projects has volumes?" });
    await h.drive(run.body.runId);
    const msgs = (await h.sessions.get(sid)).piSession.messages as any[];
    const result = msgs.find((m) => m.role === "toolResult");
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.content[0].text);
    expect(body.projects).toEqual([
      { id: "liver-ct", title: "Liver CT", kinds: ["volume", "image"], counts: { files: 15, byKind: { volume: 12, image: 3 } }, lastActivity: "2026-11-02T10:00:00Z" },
      { id: "knee-mri", title: "knee-mri", kinds: ["video"], counts: { files: 2, byKind: { video: 2 } }, lastActivity: "2026-11-01T09:00:00Z" },
    ]);
    expect(result.content[0].text).not.toMatch(/patient-042|secret notes|org_1/);
    expect(k.seen.find((s) => s.path === "/api/v1/projects")!.workspace).toBeNull();
    expect(Object.keys(projectMetadata(PROJECTS[0]!)).sort()).toEqual(["counts", "id", "kinds", "lastActivity", "title"]);
  });

  it("open_in_project makes a project chat for the same owner seeded with the request and starts its run", async () => {
    const k = fakeKernel(PROJECTS);
    const fixture = {
      scripts: [
        { when: "^start a segmentation of", turns: [{ text: "Segment the liver." }] },
        { when: "segmentation chat", turns: [{ toolCalls: [{ name: "open_in_project", arguments: { projectId: "liver-ct", request: "Start a segmentation of the liver" } }] }, { text: "Opened it." }] },
        { when: "nope", turns: [{ toolCalls: [{ name: "open_in_project", arguments: { projectId: "not-mine", request: "Do it" } }] }, { text: "Can't." }] },
      ],
    };
    h = await harness(fixture, {}, [], { fetchImpl: k.fetchImpl });
    const sid = (await h.json("POST", "/v1/sessions", { scope: "home", kernelToken: KTOKEN })).body.sessionId as string;
    const run = await h.json("POST", `/v1/sessions/${sid}/messages`, { text: "Start a segmentation chat in Liver CT" });
    const homeEvents = await h.drive(run.body.runId);
    const toolResult = homeEvents.find((e) => e.type === "tool-result") as { ok: boolean; summary: string } | undefined;
    expect(toolResult?.ok).toBe(true);
    expect(Object.keys(JSON.parse(toolResult!.summary)).sort()).toEqual(["projectId", "sessionId"]);
    const msgs = (await h.sessions.get(sid)).piSession.messages as any[];
    const result = msgs.find((m) => m.role === "toolResult");
    expect(result.isError).toBe(false);
    const opened = JSON.parse(result.content[0].text);
    expect(opened.projectId).toBe("liver-ct");
    expect(JSON.parse(toolResult!.summary)).toEqual(opened);
    // The access check named the project.
    expect(k.seen.find((s) => s.path === "/api/v1/projects/liver-ct")).toMatchObject({ workspace: "liver-ct" });

    const chats = (await h.json("GET", "/v1/sessions?projectId=liver-ct")).body.sessions;
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ id: opened.sessionId, scope: "project", projectId: "liver-ct", profile: "assistant" });
    const target = await h.sessions.get(opened.sessionId);
    expect(target.meta.owner).toBe((await h.sessions.get(sid)).meta.owner);
    expect(target.meta.seededFrom).toBe(sid);
    const runId = target.info().activeRunId ?? [...target.runs.keys()][0]!;
    await h.drive(runId);
    const thread = (await h.json("GET", `/v1/sessions/${opened.sessionId}/thread`)).body.messages;
    expect(thread[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "Start a segmentation of the liver" }] });
    expect(thread[1].parts.find((p: { type: string }) => p.type === "text").text).toContain("Segment the liver.");

    // A project the person can't open: an error result, no session made.
    const r2 = await h.json("POST", `/v1/sessions/${sid}/messages`, { text: "nope" });
    await h.drive(r2.body.runId);
    const last = ((await h.sessions.get(sid)).piSession.messages as any[]).filter((m) => m.role === "toolResult").at(-1);
    expect(last.isError).toBe(true);
    expect(last.content[0].text).toMatch(/No project "not-mine"/);
    expect((await h.json("GET", "/v1/sessions?projectId=not-mine")).body.sessions).toHaveLength(0);
  });
});

describe("todo21 D9: a project chat's tools reach only its project", { timeout: 30_000 }, () => {
  it("every tool in a project session refuses a projectId other than the session's", async () => {
    h = await harness({ scripts: [] });
    const sid = (await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools: ENV_TOOLS })).body.sessionId as string;
    const ctx = await h.sessions.get(sid);
    const names = ctx.piSession.getAllTools().map((t) => t.name);
    expect(names.length).toBeGreaterThan(10);
    const budgets = { maxToolCalls: 100, maxRunSeconds: 600, maxSpendUsd: 10 };
    for (const toolName of names) {
      for (const key of ["projectId", "workspaceId"]) {
        const d = decide({ toolName, input: { [key]: "other-project" } }, { ...ctx.policy, startedAt: Date.now() }, budgets);
        expect(d, `${toolName} ${key}`).toMatchObject({ kind: "deny", soft: true });
      }
    }
    // The session's own project passes this rule (other rules may still ask or deny).
    const own = decide({ toolName: "dataset_overview", input: { projectId: "demo" } }, { ...ctx.policy, startedAt: Date.now() }, budgets);
    expect(own.kind).toBe("allow");
  });

  it("the model gets a soft refusal and the run goes on", async () => {
    const fixture = { scripts: [{ when: "peek", turns: [{ toolCalls: [{ name: "dataset_overview", arguments: { projectId: "someone-else" } }] }, { text: "I can only see this project." }] }] };
    h = await harness(fixture);
    const sid = (await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "environment-designer", clientTools: ENV_TOOLS })).body.sessionId as string;
    const r = await h.json("POST", `/v1/sessions/${sid}/messages`, { text: "peek at someone-else" });
    const events = await h.drive(r.body.runId);
    const result = ((await h.sessions.get(sid)).piSession.messages as any[]).find((m) => m.role === "toolResult");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/scoped to project "demo"/);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
  });

  // TODO(todo21 W3): "the titler never receives tool outputs" belongs with the titler (agent/titler.ts, another worker).
});
